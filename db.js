/* SQLite 数据层：node:sqlite 内置驱动，零外部依赖 */
'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.TAXMGR_DB || path.join(__dirname, 'data', 'taxmgr.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

/* ---------- 建表（幂等） ---------- */
db.exec(`
CREATE TABLE IF NOT EXISTS regions (
  code TEXT NOT NULL,
  name_zh TEXT, name_en TEXT,
  period TEXT NOT NULL,
  effective_from TEXT, effective_to TEXT,
  avg_wage REAL,
  si_cap REAL, si_floor REAL,
  hf_cap REAL, hf_floor REAL,
  si_comp_rate REAL, si_pers_rate REAL,
  hf_rate_min REAL, hf_rate_max REAL, hf_extra_max REAL,
  source TEXT, notes TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (code, period)
);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_version TEXT,
  source TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  inserted INTEGER DEFAULT 0,
  updated INTEGER DEFAULT 0,
  unchanged INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',
  message TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  lang TEXT NOT NULL DEFAULT 'zh',
  region TEXT DEFAULT 'shanghai',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS params (
  user_id INTEGER NOT NULL DEFAULT 0,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, key)
);
`);

/* ---------- 默认税制参数（user_id=0 为全局默认，可被用户级覆盖） ---------- */
const DEFAULT_PARAMS = {
  iit_brackets: [
    [36000, 3, 0], [144000, 10, 2520], [300000, 20, 16920], [420000, 25, 31920],
    [660000, 30, 52920], [960000, 35, 85920], [null, 45, 181920],
  ],
  bonus_brackets: [
    [3000, 3, 0], [12000, 10, 210], [25000, 20, 1410], [35000, 25, 2660],
    [55000, 30, 4410], [80000, 35, 7160], [null, 45, 15160],
  ],
  cit: { smallLimit: 3000000, smallRate: 5, normalRate: 25 },
  vat: { defaultRate: 1, exemptQuarterly: 300000, surchargeRate: 12 },
  personal: { basicDeduction: 60000, dividendRate: 20 },
};

function seedDefaultParams() {
  const ins = db.prepare('INSERT OR IGNORE INTO params (user_id, key, value_json) VALUES (0, ?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_PARAMS)) ins.run(k, JSON.stringify(v));
}
seedDefaultParams();

/* ---------- 基础数据幂等同步 ---------- */
const REGION_FIELDS = [
  'name_zh', 'name_en', 'effective_from', 'effective_to', 'avg_wage',
  'si_cap', 'si_floor', 'hf_cap', 'hf_floor',
  'si_comp_rate', 'si_pers_rate', 'hf_rate_min', 'hf_rate_max', 'hf_extra_max',
  'source', 'notes',
];

function validateDataset(ds) {
  if (!ds || typeof ds !== 'object') throw new Error('数据集不是有效 JSON 对象');
  if (!Array.isArray(ds.regions) || !ds.regions.length) throw new Error('数据集缺少 regions 数组');
  for (const r of ds.regions) {
    if (!r.code || !r.period) throw new Error(`地区记录缺少 code/period：${JSON.stringify(r).slice(0, 80)}`);
  }
  return ds;
}

/**
 * 幂等可重入同步：按 (code, period) 主键 upsert，逐字段比对，
 * 无变化则跳过；整体在事务中执行，失败回滚并记录 sync_log。
 * @param {object|null} dataset 外部数据集（如远程获取的 JSON）；为空则用内置 data/base-data.json
 */
function syncBaseData(dataset = null, sourceLabel = 'bundled:data/base-data.json') {
  const ds = validateDataset(dataset || JSON.parse(
    fs.readFileSync(path.join(__dirname, 'data', 'base-data.json'), 'utf8')));

  const logIns = db.prepare(
    'INSERT INTO sync_log (dataset_version, source, started_at) VALUES (?, ?, ?)');
  const logId = logIns.run(ds.version || 'unknown', sourceLabel, new Date().toISOString()).lastInsertRowid;

  const getStmt = db.prepare('SELECT * FROM regions WHERE code = ? AND period = ?');
  const insStmt = db.prepare(`INSERT INTO regions (code, period, ${REGION_FIELDS.join(', ')}, updated_at)
    VALUES (?, ?, ${REGION_FIELDS.map(() => '?').join(', ')}, datetime('now'))`);
  const updStmt = db.prepare(`UPDATE regions SET ${REGION_FIELDS.map(f => f + ' = ?').join(', ')},
    updated_at = datetime('now') WHERE code = ? AND period = ?`);

  let inserted = 0, updated = 0, unchanged = 0;
  db.exec('BEGIN');
  try {
    for (const r of ds.regions) {
      const vals = REGION_FIELDS.map(f => r[f] ?? null);
      const cur = getStmt.get(r.code, r.period);
      if (!cur) {
        insStmt.run(r.code, r.period, ...vals);
        inserted++;
      } else if (REGION_FIELDS.some(f => (cur[f] ?? null) !== (r[f] ?? null))) {
        updStmt.run(...vals, r.code, r.period);
        updated++;
      } else {
        unchanged++;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    db.prepare("UPDATE sync_log SET status='failed', finished_at=?, message=? WHERE id=?")
      .run(new Date().toISOString(), String(err.message || err), logId);
    throw err;
  }
  db.prepare("UPDATE sync_log SET status='ok', finished_at=?, inserted=?, updated=?, unchanged=? WHERE id=?")
    .run(new Date().toISOString(), inserted, updated, unchanged, logId);
  return { version: ds.version, source: sourceLabel, inserted, updated, unchanged };
}

/* 首次启动自动灌入 */
if (db.prepare('SELECT COUNT(*) AS n FROM regions').get().n === 0) {
  syncBaseData();
}

/* ---------- 查询辅助 ---------- */
const q = {
  regionsLatest() {
    return db.prepare(`
      SELECT r.* FROM regions r
      JOIN (SELECT code, MAX(period) AS period FROM regions GROUP BY code) m
        ON r.code = m.code AND r.period = m.period
      ORDER BY r.code`).all();
  },
  regionsAll() { return db.prepare('SELECT * FROM regions ORDER BY code, period DESC').all(); },
  syncLog(limit = 20) {
    return db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT ?').all(limit);
  },

  users() { return db.prepare('SELECT * FROM users ORDER BY id').all(); },
  userCreate(name, lang = 'zh', region = 'shanghai') {
    const id = db.prepare('INSERT INTO users (name, lang, region) VALUES (?, ?, ?)').run(name, lang, region).lastInsertRowid;
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  },
  userUpdate(id, { name, lang, region }) {
    const cur = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!cur) return null;
    db.prepare('UPDATE users SET name = ?, lang = ?, region = ? WHERE id = ?')
      .run(name ?? cur.name, lang ?? cur.lang, region ?? cur.region, id);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  },
  userDelete(id) { db.prepare('DELETE FROM users WHERE id = ?').run(id); },

  plans(userId) {
    return db.prepare('SELECT id, user_id, name, updated_at FROM plans WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
  },
  planGet(id) { return db.prepare('SELECT * FROM plans WHERE id = ?').get(id); },
  planSave(userId, name, stateJson) {
    // upsert by (user_id, name) —— 保存即覆盖同名方案，幂等
    db.prepare(`INSERT INTO plans (user_id, name, state_json) VALUES (?, ?, ?)
      ON CONFLICT(user_id, name) DO UPDATE SET state_json = excluded.state_json, updated_at = datetime('now')`)
      .run(userId, name, stateJson);
    return db.prepare('SELECT * FROM plans WHERE user_id = ? AND name = ?').get(userId, name);
  },
  planDelete(id) { db.prepare('DELETE FROM plans WHERE id = ?').run(id); },

  paramsMerged(userId = 0) {
    const out = {};
    for (const row of db.prepare('SELECT key, value_json FROM params WHERE user_id = 0').all())
      out[row.key] = JSON.parse(row.value_json);
    if (userId && userId !== 0)
      for (const row of db.prepare('SELECT key, value_json FROM params WHERE user_id = ?').all(userId))
        out[row.key] = JSON.parse(row.value_json);
    return out;
  },
  paramSet(userId, key, value) {
    db.prepare(`INSERT INTO params (user_id, key, value_json) VALUES (?, ?, ?)
      ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = datetime('now')`)
      .run(userId, key, JSON.stringify(value));
  },
  paramsReset(userId) {
    if (userId === 0) {
      db.prepare('DELETE FROM params WHERE user_id = 0').run();
      seedDefaultParams();
    } else {
      db.prepare('DELETE FROM params WHERE user_id = ?').run(userId);
    }
  },
};

module.exports = { db, q, syncBaseData, DEFAULT_PARAMS };

/* 税务优化计算服务 —— 零依赖 HTTP 服务器（静态资源 + REST API + SQLite） */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { q, syncBaseData } = require('./db');

const PORT = process.env.PORT || 8787;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/* ---------- 工具 ---------- */
function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => {
      buf += c;
      if (buf.length > 5 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function fetchRemoteJSON(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:') return reject(new Error('仅支持 https 数据源'));
    https.get(u, { headers: { 'User-Agent': 'proprietor-tax-manager/1.0' }, timeout: 15000 }, resp => {
      if (resp.statusCode !== 200) return reject(new Error(`远程数据源返回 HTTP ${resp.statusCode}`));
      let buf = '';
      resp.on('data', c => { buf += c; });
      resp.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('远程数据源不是有效 JSON')); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('远程数据源超时')); });
  });
}

/* ---------- API 路由 ---------- */
async function handleAPI(req, res, pathname, query) {
  const seg = pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  // GET /api/health
  if (pathname === '/api/health') return sendJSON(res, 200, { ok: true, time: new Date().toISOString() });

  // ── 基础数据 ──
  if (pathname === '/api/regions' && method === 'GET') {
    const rows = query.get('all') === '1' ? q.regionsAll() : q.regionsLatest();
    return sendJSON(res, 200, rows);
  }
  if (pathname === '/api/sync' && method === 'POST') {
    const body = await readBody(req);
    let result;
    if (body.url) {
      const ds = await fetchRemoteJSON(body.url);
      result = syncBaseData(ds, `remote:${body.url}`);
    } else {
      result = syncBaseData();
    }
    return sendJSON(res, 200, result);
  }
  if (pathname === '/api/sync/log' && method === 'GET') return sendJSON(res, 200, q.syncLog());

  // ── 用户 ──
  if (pathname === '/api/users' && method === 'GET') return sendJSON(res, 200, q.users());
  if (pathname === '/api/users' && method === 'POST') {
    const body = await readBody(req);
    if (!body.name || !String(body.name).trim()) return sendJSON(res, 400, { error: 'name required' });
    try {
      return sendJSON(res, 201, q.userCreate(String(body.name).trim(), body.lang, body.region));
    } catch (e) {
      return sendJSON(res, 409, { error: '用户名已存在 / user name already exists' });
    }
  }
  if (seg[0] === 'api' && seg[1] === 'users' && seg[2] && !seg[3]) {
    const id = +seg[2];
    if (method === 'PUT') {
      const u = q.userUpdate(id, await readBody(req));
      return u ? sendJSON(res, 200, u) : sendJSON(res, 404, { error: 'user not found' });
    }
    if (method === 'DELETE') { q.userDelete(id); return sendJSON(res, 200, { ok: true }); }
  }

  // ── 方案 ──
  if (seg[0] === 'api' && seg[1] === 'users' && seg[2] && seg[3] === 'plans') {
    const userId = +seg[2];
    if (method === 'GET') return sendJSON(res, 200, q.plans(userId));
    if (method === 'POST') {
      const body = await readBody(req);
      if (!body.name || body.state === undefined) return sendJSON(res, 400, { error: 'name and state required' });
      const plan = q.planSave(userId, String(body.name).trim(), JSON.stringify(body.state));
      return sendJSON(res, 201, { id: plan.id, name: plan.name, updated_at: plan.updated_at });
    }
  }
  if (seg[0] === 'api' && seg[1] === 'plans' && seg[2]) {
    const id = +seg[2];
    if (method === 'GET') {
      const p = q.planGet(id);
      if (!p) return sendJSON(res, 404, { error: 'plan not found' });
      return sendJSON(res, 200, { id: p.id, user_id: p.user_id, name: p.name, updated_at: p.updated_at, state: JSON.parse(p.state_json) });
    }
    if (method === 'DELETE') { q.planDelete(id); return sendJSON(res, 200, { ok: true }); }
  }

  // ── 税制参数 ──
  if (pathname === '/api/params' && method === 'GET') {
    return sendJSON(res, 200, q.paramsMerged(+(query.get('user') || 0)));
  }
  if (pathname === '/api/params' && method === 'PUT') {
    const body = await readBody(req);
    if (!body.key || body.value === undefined) return sendJSON(res, 400, { error: 'key and value required' });
    q.paramSet(+(body.user_id || 0), body.key, body.value);
    return sendJSON(res, 200, { ok: true });
  }
  if (pathname === '/api/params/reset' && method === 'POST') {
    const body = await readBody(req);
    q.paramsReset(+(body.user_id || 0));
    return sendJSON(res, 200, { ok: true, params: q.paramsMerged(+(body.user_id || 0)) });
  }

  return sendJSON(res, 404, { error: `no route: ${method} ${pathname}` });
}

/* ---------- 静态资源 ---------- */
function serveStatic(res, pathname) {
  let file = pathname === '/' ? '/index.html' : pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (u.pathname.startsWith('/api/')) await handleAPI(req, res, u.pathname, u.searchParams);
    else serveStatic(res, u.pathname);
  } catch (err) {
    sendJSON(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`税务优化计算服务已启动: http://localhost:${PORT}`);
});

/* ============================================================
 * 企业主个人收入税务优化计算服务 —— 前端
 * 计算引擎 + 实时预览 + 用户/方案持久化 + 地区基础数据 + i18n
 * ============================================================ */

'use strict';

/* ---------- i18n ---------- */
let lang = localStorage.getItem('taxmgr.lang') || 'zh';
const t = (key, vars) => {
  let s = (I18N[lang] && I18N[lang][key]) ?? I18N.zh[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
};

/* ---------- 工具 ---------- */
const r2 = v => Math.round(v * 100) / 100;
const fmt = n => (isFinite(n) ? n : 0).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const $ = sel => document.querySelector(sel);
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2600);
}

/* ---------- 服务端 API（不可达时自动降级为离线单机模式） ---------- */
const api = {
  ok: true,
  async call(method, url, body) {
    let resp;
    try {
      resp = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      this.ok = false;
      updateServerBanner();
      throw e;
    }
    this.ok = true;
    updateServerBanner();
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    return data;
  },
  get(url) { return this.call('GET', url); },
  post(url, body) { return this.call('POST', url, body); },
  put(url, body) { return this.call('PUT', url, body); },
  del(url) { return this.call('DELETE', url); },
};

function updateServerBanner() {
  const b = $('#serverBanner');
  b.hidden = api.ok;
  if (!api.ok) b.textContent = t('toolbar.serverDown');
}

/* ---------- 默认税制参数（离线兜底，与服务端 DEFAULT_PARAMS 一致） ---------- */
const FALLBACK_PARAMS = {
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

/* ---------- 税额函数（税率以百分数存储） ---------- */
function iitAnnual(taxable, brackets) {
  if (taxable <= 0) return 0;
  for (const [lim, rate, ded] of brackets) {
    if (lim == null || taxable <= lim) return taxable * rate / 100 - ded;
  }
  return 0;
}

function bonusTax(bonus, brackets) {
  if (bonus <= 0) return 0;
  const monthly = bonus / 12;
  for (const [lim, rate, ded] of brackets) {
    if (lim == null || monthly <= lim) return bonus * rate / 100 - ded;
  }
  return 0;
}

/* ---------- 专项附加扣除项 ---------- */
const DEDUCTION_KEYS = [
  { key: 'rent',  def: 1500 },
  { key: 'loan',  def: 1000 },
  { key: 'child', def: 2000 },
  { key: 'baby',  def: 2000 },
  { key: 'elder', def: 3000 },
  { key: 'edu',   def: 400 },
];

/* ---------- 状态 ---------- */
let empSeq = 0;

function newEmployee(over = {}) {
  const ded = {};
  DEDUCTION_KEYS.forEach(d => { ded[d.key] = { on: false, amt: d.def }; });
  return Object.assign({
    id: ++empSeq,
    name: t('emp.defaultName'),
    salary: 10000,
    months: 12,
    hasSI: true,
    base: 10000,
    hfRate: 7,
    hfExtra: 0,
    bonus: 0,
    family: false,
    ded,
  }, over);
}

const state = {
  region: 'shanghai',
  vatRate: 1,
  surchargeRate: 12,
  quarterMode: 'custom',
  annualRevenue: 1800000,
  quarters: [290000, 290000, 290000, 930000],
  si: { compRate: 25.7, persRate: 10.5, capBase: 37302, floorBase: 7460 },
  rentReimburse: 10000,
  otherCost: 0,
  distributeDividend: false,
  employees: [],
  snapshots: [],
  params: JSON.parse(JSON.stringify(FALLBACK_PARAMS)),
};

/* 应用级数据（用户 / 方案 / 地区） */
const app = {
  users: [],
  currentUserId: null,
  plans: [],
  currentPlanId: null,
  regions: [],
};

/* ---------- 预设方案 ---------- */
function presetOriginal() {
  state.quarterMode = 'avg';
  state.annualRevenue = 1800000;
  state.quarters = [450000, 450000, 450000, 450000];
  state.rentReimburse = 0;
  state.otherCost = 0;
  state.distributeDividend = false;
  state.employees = [
    newEmployee({ name: 'A（老板）', salary: 60000, base: 37302, hfRate: 7, hfExtra: 5, family: true }),
    newEmployee({ name: 'B', salary: 30000, base: 30000, hfRate: 7, hfExtra: 0 }),
  ];
}

function presetOptimized() {
  state.quarterMode = 'custom';
  state.quarters = [290000, 290000, 290000, 930000];
  state.annualRevenue = 1800000;
  state.rentReimburse = 10000;
  state.otherCost = 0;
  state.distributeDividend = false;
  state.employees = [
    newEmployee({ name: 'A（老板）', salary: 23000, base: 37302, hfRate: 7, hfExtra: 5, bonus: 36000, family: true }),
    newEmployee({ name: 'B', salary: 30000, base: 30000, hfRate: 7, hfExtra: 0 }),
    newEmployee({ name: 'C（女儿·实习）', salary: 5000, hasSI: false, hfRate: 0, family: true }),
    newEmployee({ name: '实习生D', salary: 5000, hasSI: false, hfRate: 0 }),
  ];
}

/* ---------- 核心计算 ---------- */
function compute(s) {
  const p = s.params;

  // ── 增值税：季度不含税销售额 ≤ 免税额度则免征 ──
  const vatR = num(s.vatRate) / 100;
  const exemptQ = num(p.vat.exemptQuarterly);
  const quarters = s.quarterMode === 'avg'
    ? Array(4).fill(num(s.annualRevenue) / 4)
    : s.quarters.map(num);
  let vat = 0, incomeNet = 0;
  const qDetails = quarters.map((gross, i) => {
    const net = gross / (1 + vatR);
    if (net <= exemptQ + 1e-6) {
      incomeNet += gross;
      return { q: i + 1, gross, net: gross, vat: 0, exempt: true };
    }
    const v = r2(net * vatR);
    vat += v;
    incomeNet += net;
    return { q: i + 1, gross, net: r2(net), vat: v, exempt: false };
  });
  vat = r2(vat);
  const surcharge = r2(vat * num(s.surchargeRate) / 100);
  const totalGross = quarters.reduce((a, b) => a + b, 0);

  // ── 人员：社保公积金 + 个税 ──
  const basicDed = num(p.personal.basicDeduction);
  const emps = s.employees.map(e => {
    const base = Math.max(num(e.base), 0);
    const hfR = (num(e.hfRate) + num(e.hfExtra)) / 100;
    const mCompSI = e.hasSI ? r2(base * s.si.compRate / 100) : 0;
    const mPersSI = e.hasSI ? r2(base * s.si.persRate / 100) : 0;
    const mCompHF = e.hasSI ? r2(base * hfR) : 0;
    const mPersHF = e.hasSI ? r2(base * hfR) : 0;
    const annCompSIHF = r2((mCompSI + mCompHF) * e.months);
    const annPersSIHF = r2((mPersSI + mPersHF) * e.months);

    let dedAnnual = 0;
    DEDUCTION_KEYS.forEach(d => { if (e.ded[d.key].on) dedAnnual += num(e.ded[d.key].amt) * 12; });

    const grossSalary = num(e.salary) * e.months;
    const bonus = num(e.bonus);
    const taxable = grossSalary - basicDed - annPersSIHF - dedAnnual;
    const iit = r2(iitAnnual(taxable, p.iit_brackets));
    const bTax = r2(bonusTax(bonus, p.bonus_brackets));
    const netCash = r2(grossSalary + bonus - annPersSIHF - iit - bTax);
    const hfTotal = r2((mCompHF + mPersHF) * e.months);

    return {
      e, grossSalary, bonus, mCompSI, mCompHF, mPersSI, mPersHF,
      annCompSIHF, annPersSIHF, dedAnnual, taxable, iit, bTax, netCash, hfTotal,
      companyCost: r2(grossSalary + bonus + annCompSIHF),
    };
  });

  const laborCost = r2(emps.reduce((a, x) => a + x.companyCost, 0));
  const totalCompSIHF = r2(emps.reduce((a, x) => a + x.annCompSIHF, 0));
  const totalIIT = r2(emps.reduce((a, x) => a + x.iit + x.bTax, 0));
  const rentAnnual = r2(num(s.rentReimburse) * 12);

  // ── 企业所得税 ──
  const totalCost = r2(laborCost + rentAnnual + num(s.otherCost) + surcharge);
  const profit = r2(incomeNet - totalCost);
  let cit = 0, citSmall = true;
  if (profit > 0) {
    if (profit <= num(p.cit.smallLimit)) cit = r2(profit * num(p.cit.smallRate) / 100);
    else { cit = r2(profit * num(p.cit.normalRate) / 100); citSmall = false; }
  }
  const profitAfter = r2(profit - cit);

  // ── 分红 ──
  const divRate = num(p.personal.dividendRate);
  const divTax = s.distributeDividend && profitAfter > 0 ? r2(profitAfter * divRate / 100) : 0;
  const divNet = s.distributeDividend ? r2(profitAfter - divTax) : 0;

  // ── 家庭收益 ──
  const famEmps = emps.filter(x => x.e.family);
  const famCash = r2(famEmps.reduce((a, x) => a + x.netCash, 0));
  const famHF = r2(famEmps.reduce((a, x) => a + x.hfTotal, 0));
  const famTotal = r2(famCash + famHF + rentAnnual + divNet);

  const totalTax = r2(vat + surcharge + cit + totalIIT + divTax);

  return {
    quarters, qDetails, vat, surcharge, totalGross, incomeNet,
    emps, laborCost, totalCompSIHF, totalIIT, rentAnnual,
    totalCost, profit, cit, citSmall, profitAfter, divTax, divNet,
    famCash, famHF, famTotal, totalTax,
    taxRate: totalGross > 0 ? totalTax / totalGross : 0,
  };
}

/* ---------- 工资 / 年终奖拆分优化 ---------- */
function optimizeSplit(totalCash, annPersSIHF, dedAnnual, p) {
  const basicDed = num(p.personal.basicDeduction);
  const taxOf = b => {
    const taxable = (totalCash - b) - basicDed - annPersSIHF - dedAnnual;
    return iitAnnual(Math.max(taxable, 0), p.iit_brackets) + bonusTax(b, p.bonus_brackets);
  };
  let best = { b: 0, tax: taxOf(0) };
  const candidates = new Set([0, totalCash]);
  for (const [lim] of p.iit_brackets) if (lim != null) candidates.add(lim);
  for (const [lim] of p.bonus_brackets) if (lim != null) candidates.add(lim * 12);
  for (let b = 0; b <= totalCash; b += 500) candidates.add(b);
  for (const b of candidates) {
    if (b < 0 || b > totalCash) continue;
    const tax = taxOf(b);
    if (tax < best.tax - 0.005) best = { b, tax };
  }
  return best;
}

/* ============================================================
 * 渲染
 * ============================================================ */

function applyStaticI18n() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  $('#btnLang').textContent = lang === 'zh' ? 'EN' : '中文';
  updateServerBanner();
}

/* ---------- 工具栏（用户 / 方案） ---------- */
function renderToolbar() {
  const uSel = $('#userSel');
  uSel.innerHTML = app.users.map(u =>
    `<option value="${u.id}" ${u.id === app.currentUserId ? 'selected' : ''}>${esc(u.name)}</option>`).join('')
    || `<option value="">—</option>`;
  const pSel = $('#planSel');
  pSel.innerHTML = `<option value="">${t('toolbar.noPlan')}</option>` + app.plans.map(pl =>
    `<option value="${pl.id}" ${pl.id === app.currentPlanId ? 'selected' : ''}>${esc(pl.name)}</option>`).join('');
}

/* ---------- 地区基础数据 ---------- */
function renderRegions() {
  const sel = $('#regionSel');
  if (!app.regions.length) {
    sel.innerHTML = `<option value="">${t('region.none')}</option>`;
    $('#regionInfo').innerHTML = '';
    return;
  }
  sel.innerHTML = app.regions.map(r =>
    `<option value="${r.code}" ${r.code === state.region ? 'selected' : ''}>${esc(lang === 'zh' ? r.name_zh : r.name_en)}</option>`).join('');
  const r = app.regions.find(x => x.code === state.region) || app.regions[0];
  const v = x => x == null ? '—' : fmt(x);
  $('#regionInfo').innerHTML = `
    <div class="region-grid">
      <div class="rcell"><span>${t('region.period')}</span><b>${esc(r.period)}（${esc(r.effective_from || '')} ~ ${esc(r.effective_to || '')}）</b></div>
      <div class="rcell"><span>${t('region.avgWage')}</span><b>${v(r.avg_wage)}</b></div>
      <div class="rcell"><span>${t('region.siCap')}</span><b>${v(r.si_cap)}</b></div>
      <div class="rcell"><span>${t('region.siFloor')}</span><b>${v(r.si_floor)}</b></div>
      <div class="rcell"><span>${t('region.hfCap')}</span><b>${v(r.hf_cap)}</b></div>
      <div class="rcell"><span>${t('region.hfFloor')}</span><b>${v(r.hf_floor)}</b></div>
    </div>
    <p class="note">${esc(r.notes || '')}<br>
      ${t('region.source')}：${(r.source || '').split(';').map(u => u.trim()).filter(Boolean)
        .map(u => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(new URL(u).hostname)}</a>`).join(' · ')}</p>`;
}

/* ---------- 税制参数编辑器 ---------- */
function renderParams() {
  const p = state.params;
  const bracketTable = (name, brackets, upToLabel) => `
    <p class="params-sub">${name === 'iit_brackets' ? t('params.iit') : t('params.bonus')}</p>
    <div class="tbl-wrap"><table class="tbl params-tbl">
      <tr><th>${upToLabel}</th><th>${t('params.rate')}</th><th>${t('params.quick')}</th></tr>
      ${brackets.map((row, i) => `<tr>
        <td>${row[0] == null ? t('params.inf')
          : `<input type="number" data-pb="${name}" data-i="${i}" data-j="0" value="${row[0]}">`}</td>
        <td><input type="number" step="1" data-pb="${name}" data-i="${i}" data-j="1" value="${row[1]}"></td>
        <td><input type="number" data-pb="${name}" data-i="${i}" data-j="2" value="${row[2]}"></td>
      </tr>`).join('')}
    </table></div>`;

  $('#paramsBox').innerHTML = `
    ${bracketTable('iit_brackets', p.iit_brackets, t('params.upTo'))}
    ${bracketTable('bonus_brackets', p.bonus_brackets, t('params.upToMonthly'))}
    <p class="params-sub">${t('params.cit')} / ${t('params.vatMisc')}</p>
    <div class="grid3">
      <label><span>${t('params.smallLimit')}</span><input type="number" data-pk="cit.smallLimit" value="${p.cit.smallLimit}"></label>
      <label><span>${t('params.smallRate')}</span><input type="number" step="0.5" data-pk="cit.smallRate" value="${p.cit.smallRate}"></label>
      <label><span>${t('params.normalRate')}</span><input type="number" step="0.5" data-pk="cit.normalRate" value="${p.cit.normalRate}"></label>
      <label><span>${t('params.exemptQuarterly')}</span><input type="number" data-pk="vat.exemptQuarterly" value="${p.vat.exemptQuarterly}"></label>
      <label><span>${t('params.basicDeduction')}</span><input type="number" data-pk="personal.basicDeduction" value="${p.personal.basicDeduction}"></label>
      <label><span>${t('params.dividendRate')}</span><input type="number" step="1" data-pk="personal.dividendRate" value="${p.personal.dividendRate}"></label>
    </div>`;
}

/* ---------- 员工卡片 ---------- */
function renderEmployees() {
  const wrap = $('#empList');
  wrap.innerHTML = state.employees.map(e => {
    const dedChips = DEDUCTION_KEYS.map(d => `
      <label class="chip ${e.ded[d.key].on ? 'on' : ''}">
        <input type="checkbox" data-emp="${e.id}" data-ded="${d.key}" ${e.ded[d.key].on ? 'checked' : ''}>
        ${t('ded.' + d.key)}
        <input type="number" class="chip-amt" data-emp="${e.id}" data-dedamt="${d.key}"
               value="${e.ded[d.key].amt}" ${e.ded[d.key].on ? '' : 'disabled'}> ${t('emp.perMonth')}
      </label>`).join('');
    return `
    <div class="card emp-card" data-empcard="${e.id}">
      <div class="emp-head">
        <input class="emp-name" data-emp="${e.id}" data-f="name" value="${esc(e.name)}">
        <label class="mini"><input type="checkbox" data-emp="${e.id}" data-f="family" ${e.family ? 'checked' : ''}>${t('emp.family')}</label>
        <button class="btn-del" data-del="${e.id}" title="delete">✕</button>
      </div>
      <div class="grid3">
        <label><span>${t('emp.salary')}</span><input type="number" data-emp="${e.id}" data-f="salary" value="${e.salary}"></label>
        <label><span>${t('emp.months')}</span><input type="number" data-emp="${e.id}" data-f="months" value="${e.months}" min="1" max="12"></label>
        <label><span>${t('emp.bonus')}</span><input type="number" data-emp="${e.id}" data-f="bonus" value="${e.bonus}"></label>
      </div>
      <div class="grid3">
        <label class="mini si-toggle"><input type="checkbox" data-emp="${e.id}" data-f="hasSI" ${e.hasSI ? 'checked' : ''}>${t('emp.hasSI')}</label>
        <label><span>${t('emp.base')}</span>
          <span class="base-row">
            <input type="number" data-emp="${e.id}" data-f="base" value="${e.base}" ${e.hasSI ? '' : 'disabled'}>
            <button class="btn-xs" data-basecap="${e.id}" ${e.hasSI ? '' : 'disabled'}>${t('emp.baseCap')}</button>
            <button class="btn-xs" data-basesalary="${e.id}" ${e.hasSI ? '' : 'disabled'}>${t('emp.baseSalary')}</button>
          </span>
        </label>
        <label><span>${t('emp.hfRates')}</span>
          <span class="base-row">
            <input type="number" data-emp="${e.id}" data-f="hfRate" value="${e.hfRate}" ${e.hasSI ? '' : 'disabled'}> +
            <input type="number" data-emp="${e.id}" data-f="hfExtra" value="${e.hfExtra}" ${e.hasSI ? '' : 'disabled'}>
          </span>
        </label>
      </div>
      <details class="ded-box">
        <summary>${t('emp.dedSummary')}</summary>
        <div class="chips">${dedChips}</div>
      </details>
      <div class="opt-row">
        <button class="btn-secondary" data-optimize="${e.id}">${t('emp.optimizeBtn')}</button>
        <span class="opt-hint" data-opthint="${e.id}"></span>
      </div>
    </div>`;
  }).join('');
}

/* ---------- 季度开票 ---------- */
function renderQuarters() {
  const box = $('#quarterBox');
  const isCustom = state.quarterMode === 'custom';
  $('#annualRevWrap').style.display = isCustom ? 'none' : '';
  box.style.display = isCustom ? '' : 'none';
  if (isCustom) {
    box.querySelectorAll('input[data-q]').forEach(inp => { inp.value = state.quarters[+inp.dataset.q]; });
    const sum = state.quarters.reduce((a, b) => a + num(b), 0);
    $('#qSum').textContent = t('vat.qSum', { v: fmt(sum) });
  }
}

/* ---------- 结果 ---------- */
function renderResults() {
  const r = compute(state);

  $('#kpis').innerHTML = `
    <div class="kpi"><span>${t('kpi.totalTax')}</span><b>¥ ${fmt(r.totalTax)}</b></div>
    <div class="kpi"><span>${t('kpi.taxRate')}</span><b>${(r.taxRate * 100).toFixed(2)}%</b></div>
    <div class="kpi"><span>${t('kpi.profitAfter')}</span><b>¥ ${fmt(r.profitAfter)}</b></div>
    <div class="kpi"><span>${t('kpi.famTotal')}</span><b>¥ ${fmt(r.famTotal)}</b></div>`;

  $('#vatTable').innerHTML = `
    <tr><th>${t('tbl.quarter')}</th><th>${t('tbl.grossInvoice')}</th><th>${t('tbl.netSales')}</th><th>${t('tbl.vat')}</th><th>${t('tbl.status')}</th></tr>
    ${r.qDetails.map(q => `<tr>
      <td>Q${q.q}</td><td>${fmt(q.gross)}</td><td>${fmt(q.net)}</td><td>${fmt(q.vat)}</td>
      <td>${q.exempt ? `<span class="tag ok">${t('tbl.exempt')}</span>` : `<span class="tag">${t('tbl.taxed')}</span>`}</td>
    </tr>`).join('')}
    <tr class="total"><td>${t('tbl.total')}</td><td>${fmt(r.totalGross)}</td><td>${fmt(r.incomeNet)}</td><td>${fmt(r.vat)}</td><td></td></tr>
    <tr class="total"><td colspan="3">${t('tbl.surchargeLine', { r: state.surchargeRate })}</td><td>${fmt(r.surcharge)}</td><td></td></tr>`;

  $('#empTable').innerHTML = `
    <tr><th>${t('tbl.name')}</th><th>${t('tbl.annualPay')}</th><th>${t('tbl.compSIHF')}</th><th>${t('tbl.persSIHF')}</th><th>${t('tbl.iit')}</th><th>${t('tbl.netCash')}</th><th>${t('tbl.hfIn')}</th></tr>
    ${r.emps.map(x => `<tr>
      <td>${esc(x.e.name)}${x.e.family ? ` <span class="tag fam">${t('tag.family')}</span>` : ''}</td>
      <td>${fmt(x.grossSalary + x.bonus)}</td>
      <td>${fmt(x.annCompSIHF)}</td>
      <td>${fmt(x.annPersSIHF)}</td>
      <td>${fmt(x.iit + x.bTax)}</td>
      <td>${fmt(x.netCash)}</td>
      <td>${fmt(x.hfTotal)}</td>
    </tr>`).join('')}
    <tr class="total"><td>${t('tbl.total')}</td>
      <td>${fmt(r.emps.reduce((a, x) => a + x.grossSalary + x.bonus, 0))}</td>
      <td>${fmt(r.totalCompSIHF)}</td>
      <td>${fmt(r.emps.reduce((a, x) => a + x.annPersSIHF, 0))}</td>
      <td>${fmt(r.totalIIT)}</td>
      <td>${fmt(r.emps.reduce((a, x) => a + x.netCash, 0))}</td>
      <td>${fmt(r.emps.reduce((a, x) => a + x.hfTotal, 0))}</td></tr>`;

  const citRateLabel = r.citSmall
    ? t('cit.small', { r: state.params.cit.smallRate })
    : t('cit.normal', { r: state.params.cit.normalRate });
  $('#citBox').innerHTML = `
    <div class="line"><span>${t('cit.income')}</span><b>${fmt(r.incomeNet)}</b></div>
    <div class="line"><span>${t('cit.labor')}</span><b>${fmt(r.laborCost)}</b></div>
    <div class="line"><span>${t('cit.rent')}</span><b>${fmt(r.rentAnnual)}</b></div>
    <div class="line"><span>${t('cit.other')}</span><b>${fmt(num(state.otherCost))}</b></div>
    <div class="line"><span>${t('cit.surcharge')}</span><b>${fmt(r.surcharge)}</b></div>
    <div class="line em"><span>${t('cit.taxable')}</span><b>${fmt(r.profit)}</b></div>
    <div class="line"><span>${t('cit.citLine', { r: citRateLabel })}</span><b>${fmt(r.cit)}</b></div>
    <div class="line em"><span>${t('cit.profitAfter')}</span><b>${fmt(r.profitAfter)}</b></div>
    ${state.distributeDividend ? `
      <div class="line"><span>${t('cit.divTax', { r: state.params.personal.dividendRate })}</span><b>${fmt(r.divTax)}</b></div>
      <div class="line em"><span>${t('cit.divNet')}</span><b>${fmt(r.divNet)}</b></div>` : ''}`;

  $('#taxBox').innerHTML = `
    <div class="line"><span>${t('tax.vat')}</span><b>${fmt(r.vat)}</b></div>
    <div class="line"><span>${t('tax.surcharge')}</span><b>${fmt(r.surcharge)}</b></div>
    <div class="line"><span>${t('tax.cit')}</span><b>${fmt(r.cit)}</b></div>
    <div class="line"><span>${t('tax.iitAll')}</span><b>${fmt(r.totalIIT)}</b></div>
    ${state.distributeDividend ? `<div class="line"><span>${t('tax.divTax')}</span><b>${fmt(r.divTax)}</b></div>` : ''}
    <div class="line em"><span>${t('tax.total')}</span><b>${fmt(r.totalTax)}</b></div>
    <div class="line dim"><span>${t('tax.sihfNote')}</span><b>${fmt(r.totalCompSIHF)}</b></div>`;

  $('#famBox').innerHTML = `
    <div class="line"><span>${t('fam.cash')}</span><b>${fmt(r.famCash)}</b></div>
    <div class="line"><span>${t('fam.hf')}</span><b>${fmt(r.famHF)}</b></div>
    <div class="line"><span>${t('fam.rent')}</span><b>${fmt(r.rentAnnual)}</b></div>
    <div class="line"><span>${t('fam.div')}</span><b>${fmt(r.divNet)}</b></div>
    <div class="line em"><span>${t('fam.total')}</span><b>${fmt(r.famTotal)}</b></div>
    <div class="line dim"><span>${t('fam.retained')}</span><b>${fmt(state.distributeDividend ? 0 : r.profitAfter)}</b></div>`;

  renderSnapshots();
}

function renderSnapshots() {
  const box = $('#snapBox');
  if (!state.snapshots.length) { box.innerHTML = `<p class="dim">${t('snap.empty')}</p>`; return; }
  const rows = [
    [t('kpi.totalTax'), s => fmt(s.totalTax)],
    [t('snap.vatPlus'), s => fmt(r2(s.vat + s.surcharge))],
    [t('tax.cit'), s => fmt(s.cit)],
    [t('tax.iitAll'), s => fmt(s.totalIIT)],
    [t('snap.sihf'), s => fmt(s.totalCompSIHF)],
    [t('kpi.profitAfter'), s => fmt(s.profitAfter)],
    [t('kpi.famTotal'), s => fmt(s.famTotal)],
    [t('kpi.taxRate'), s => (s.taxRate * 100).toFixed(2) + '%'],
  ];
  box.innerHTML = `<div class="tbl-wrap"><table class="tbl">
    <tr><th></th>${state.snapshots.map((s, i) => `<th>${esc(s.name)} <button class="btn-del btn-xs" data-delsnap="${i}">✕</button></th>`).join('')}</tr>
    ${rows.map(([label, f]) => `<tr><td>${label}</td>${state.snapshots.map(s => `<td>${f(s.data)}</td>`).join('')}</tr>`).join('')}
  </table></div>`;
}

function syncTopForm() {
  $('#annualRevenue').value = state.annualRevenue;
  $('#vatRate').value = state.vatRate;
  $('#surchargeRate').value = state.surchargeRate;
  $('#rentReimburse').value = state.rentReimburse;
  $('#otherCost').value = state.otherCost;
  $('#siCompRate').value = state.si.compRate;
  $('#siPersRate').value = state.si.persRate;
  $('#siCap').value = state.si.capBase;
  $('#siFloor').value = state.si.floorBase;
  $('#dividend').checked = state.distributeDividend;
  document.querySelectorAll('input[name="qmode"]').forEach(rb => { rb.checked = rb.value === state.quarterMode; });
  renderQuarters();
}

function renderAll() {
  applyStaticI18n();
  renderToolbar();
  renderRegions();
  syncTopForm();
  renderParams();
  renderEmployees();
  renderResults();
}

/* ============================================================
 * 服务端数据流（用户 / 方案 / 参数 / 地区）
 * ============================================================ */

async function loadRegions() {
  try { app.regions = await api.get('/api/regions'); } catch (e) { app.regions = []; }
}

async function loadUsers() {
  try {
    app.users = await api.get('/api/users');
    if (!app.users.length) {
      const u = await api.post('/api/users', { name: lang === 'zh' ? '默认用户' : 'Default', lang });
      app.users = [u];
    }
    const saved = +localStorage.getItem('taxmgr.userId');
    app.currentUserId = app.users.some(u => u.id === saved) ? saved : app.users[0].id;
    localStorage.setItem('taxmgr.userId', app.currentUserId);
  } catch (e) {
    app.users = []; app.currentUserId = null;
  }
}

async function loadPlans() {
  if (!app.currentUserId) { app.plans = []; app.currentPlanId = null; return; }
  try {
    app.plans = await api.get(`/api/users/${app.currentUserId}/plans`);
    const saved = +localStorage.getItem('taxmgr.planId');
    app.currentPlanId = app.plans.some(p => p.id === saved) ? saved : null;
  } catch (e) { app.plans = []; app.currentPlanId = null; }
}

async function loadParams() {
  try {
    const p = await api.get(`/api/params?user=${app.currentUserId || 0}`);
    if (p && p.iit_brackets) state.params = p;
  } catch (e) { /* 离线兜底：保留 FALLBACK_PARAMS */ }
}

function applyPlanState(saved) {
  // 逐字段合并，保证旧版方案缺字段时有默认值
  const keep = ['region', 'vatRate', 'surchargeRate', 'quarterMode', 'annualRevenue',
    'quarters', 'si', 'rentReimburse', 'otherCost', 'distributeDividend', 'employees', 'params'];
  for (const k of keep) if (saved[k] !== undefined) state[k] = saved[k];
  if (!state.params || !state.params.iit_brackets) state.params = JSON.parse(JSON.stringify(FALLBACK_PARAMS));
  // 重建员工 id 序列，避免与新建冲突
  empSeq = Math.max(0, ...state.employees.map(e => e.id || 0));
  state.snapshots = saved.snapshots || [];
}

function planPayload() {
  const { snapshots, ...rest } = state;
  return { ...rest, snapshots };
}

async function loadPlanById(id) {
  const p = await api.get(`/api/plans/${id}`);
  applyPlanState(p.state);
  app.currentPlanId = p.id;
  localStorage.setItem('taxmgr.planId', p.id);
  renderAll();
  toast(t('msg.planLoaded', { n: p.name }));
}

async function savePlan(name) {
  if (!app.currentUserId) return toast(t('msg.needUser'));
  const saved = await api.post(`/api/users/${app.currentUserId}/plans`, { name, state: planPayload() });
  await loadPlans();
  app.currentPlanId = app.plans.find(p => p.name === name)?.id ?? saved.id;
  localStorage.setItem('taxmgr.planId', app.currentPlanId);
  renderToolbar();
  toast(t('msg.planSaved', { n: name }));
}

/* ============================================================
 * 事件绑定
 * ============================================================ */
function bindEvents() {
  /* 预设 */
  $('#btnOriginal').addEventListener('click', () => { presetOriginal(); renderAll(); });
  $('#btnOptimized').addEventListener('click', () => { presetOptimized(); renderAll(); });

  /* 语言切换 */
  $('#btnLang').addEventListener('click', () => {
    lang = lang === 'zh' ? 'en' : 'zh';
    localStorage.setItem('taxmgr.lang', lang);
    if (app.currentUserId) api.put(`/api/users/${app.currentUserId}`, { lang }).catch(() => {});
    renderAll();
  });

  /* 用户 */
  $('#userSel').addEventListener('change', async e => {
    app.currentUserId = +e.target.value || null;
    localStorage.setItem('taxmgr.userId', app.currentUserId);
    localStorage.removeItem('taxmgr.planId');
    app.currentPlanId = null;
    await Promise.all([loadPlans(), loadParams()]);
    renderAll();
  });
  $('#btnNewUser').addEventListener('click', async () => {
    const name = prompt(t('prompt.newUser'));
    if (!name || !name.trim()) return;
    try {
      const u = await api.post('/api/users', { name: name.trim(), lang });
      app.users.push(u);
      app.currentUserId = u.id;
      localStorage.setItem('taxmgr.userId', u.id);
      app.plans = []; app.currentPlanId = null;
      await loadParams();
      renderAll();
      toast(t('msg.userCreated', { n: u.name }));
    } catch (e) { toast(String(e.message || e)); }
  });

  /* 方案 */
  $('#planSel').addEventListener('change', async e => {
    const id = +e.target.value;
    if (!id) { app.currentPlanId = null; localStorage.removeItem('taxmgr.planId'); return; }
    try { await loadPlanById(id); } catch (err) { toast(String(err.message || err)); }
  });
  $('#btnSavePlan').addEventListener('click', async () => {
    const cur = app.plans.find(p => p.id === app.currentPlanId);
    const name = cur ? cur.name : prompt(t('prompt.planName'));
    if (!name || !name.trim()) return;
    try { await savePlan(name.trim()); } catch (e) { toast(String(e.message || e)); }
  });
  $('#btnSaveAs').addEventListener('click', async () => {
    const name = prompt(t('prompt.planName'));
    if (!name || !name.trim()) return;
    try { await savePlan(name.trim()); } catch (e) { toast(String(e.message || e)); }
  });
  $('#btnDelPlan').addEventListener('click', async () => {
    if (!app.currentPlanId) return;
    if (!confirm(t('confirm.deletePlan'))) return;
    try {
      await api.del(`/api/plans/${app.currentPlanId}`);
      app.currentPlanId = null;
      localStorage.removeItem('taxmgr.planId');
      await loadPlans();
      renderToolbar();
    } catch (e) { toast(String(e.message || e)); }
  });

  /* 地区 */
  $('#regionSel').addEventListener('change', e => {
    state.region = e.target.value;
    renderRegions();
  });
  $('#btnSync').addEventListener('click', async () => {
    const btn = $('#btnSync');
    btn.disabled = true;
    btn.textContent = t('region.syncing');
    try {
      const res = await api.post('/api/sync', {});
      await loadRegions();
      renderRegions();
      const st = $('#syncStatus');
      st.hidden = false;
      st.textContent = t('region.syncDone', { v: res.version, i: res.inserted, u: res.updated, s: res.unchanged });
    } catch (e) { toast(String(e.message || e)); }
    btn.disabled = false;
    btn.textContent = t('region.sync');
  });
  $('#btnApplyRegion').addEventListener('click', () => {
    const r = app.regions.find(x => x.code === state.region);
    if (!r) return;
    if (r.si_cap != null) state.si.capBase = r.si_cap;
    if (r.si_floor != null) state.si.floorBase = r.si_floor;
    if (r.si_comp_rate != null) state.si.compRate = r.si_comp_rate;
    if (r.si_pers_rate != null) state.si.persRate = r.si_pers_rate;
    syncTopForm();
    renderResults();
    toast(t('region.applied'));
  });

  /* 公司参数 */
  const topFields = {
    annualRevenue: v => state.annualRevenue = num(v),
    vatRate: v => state.vatRate = num(v),
    surchargeRate: v => state.surchargeRate = num(v),
    rentReimburse: v => state.rentReimburse = num(v),
    otherCost: v => state.otherCost = num(v),
    siCompRate: v => state.si.compRate = num(v),
    siPersRate: v => state.si.persRate = num(v),
    siCap: v => state.si.capBase = num(v),
    siFloor: v => state.si.floorBase = num(v),
  };
  Object.keys(topFields).forEach(id => {
    $('#' + id).addEventListener('input', e => { topFields[id](e.target.value); renderResults(); });
  });
  $('#dividend').addEventListener('change', e => { state.distributeDividend = e.target.checked; renderResults(); });

  document.querySelectorAll('input[name="qmode"]').forEach(rb => {
    rb.addEventListener('change', () => { state.quarterMode = rb.value; renderQuarters(); renderResults(); });
  });
  document.querySelectorAll('#quarterBox input[data-q]').forEach(inp => {
    inp.addEventListener('input', () => {
      state.quarters[+inp.dataset.q] = num(inp.value);
      $('#qSum').textContent = t('vat.qSum', { v: fmt(state.quarters.reduce((a, b) => a + num(b), 0)) });
      renderResults();
    });
  });
  $('#btnQOptimize').addEventListener('click', () => {
    const total = state.quarterMode === 'avg'
      ? num(state.annualRevenue)
      : state.quarters.reduce((a, b) => a + num(b), 0);
    const per = Math.min(num(state.params.vat.exemptQuarterly), total / 4);
    state.quarters = [per, per, per, r2(total - per * 3)];
    state.quarterMode = 'custom';
    syncTopForm();
    renderResults();
  });

  /* 税制参数编辑 */
  $('#paramsBox').addEventListener('input', e => {
    const tgt = e.target;
    if (tgt.dataset.pb) {
      state.params[tgt.dataset.pb][+tgt.dataset.i][+tgt.dataset.j] = num(tgt.value);
    } else if (tgt.dataset.pk) {
      const [a, b] = tgt.dataset.pk.split('.');
      state.params[a][b] = num(tgt.value);
    } else return;
    renderResults();
  });
  $('#btnSaveParams').addEventListener('click', async () => {
    if (!app.currentUserId) return toast(t('msg.needUser'));
    try {
      for (const key of Object.keys(state.params)) {
        await api.put('/api/params', { user_id: app.currentUserId, key, value: state.params[key] });
      }
      toast(t('params.saved'));
    } catch (e) { toast(String(e.message || e)); }
  });
  $('#btnResetParams').addEventListener('click', async () => {
    try {
      const res = await api.post('/api/params/reset', { user_id: app.currentUserId || 0 });
      state.params = res.params;
    } catch (e) {
      state.params = JSON.parse(JSON.stringify(FALLBACK_PARAMS));
    }
    renderParams();
    renderResults();
  });

  /* 员工区 */
  $('#empList').addEventListener('input', e => {
    const tgt = e.target;
    const emp = state.employees.find(x => x.id === +tgt.dataset.emp);
    if (!emp) return;
    if (tgt.dataset.f) {
      const f = tgt.dataset.f;
      if (f === 'name') emp.name = tgt.value;
      else if (f === 'family' || f === 'hasSI') emp[f] = tgt.checked;
      else emp[f] = num(tgt.value);
      if (f === 'hasSI') renderEmployees();
    } else if (tgt.dataset.ded) {
      emp.ded[tgt.dataset.ded].on = tgt.checked;
      renderEmployees();
    } else if (tgt.dataset.dedamt) {
      emp.ded[tgt.dataset.dedamt].amt = num(tgt.value);
    }
    renderResults();
  });

  $('#empList').addEventListener('click', e => {
    const tgt = e.target;
    if (tgt.dataset.del) {
      state.employees = state.employees.filter(x => x.id !== +tgt.dataset.del);
      renderEmployees(); renderResults();
    } else if (tgt.dataset.basecap) {
      state.employees.find(x => x.id === +tgt.dataset.basecap).base = state.si.capBase;
      renderEmployees(); renderResults();
    } else if (tgt.dataset.basesalary) {
      const emp = state.employees.find(x => x.id === +tgt.dataset.basesalary);
      emp.base = clamp(emp.salary, state.si.floorBase, state.si.capBase);
      renderEmployees(); renderResults();
    } else if (tgt.dataset.optimize) {
      const emp = state.employees.find(x => x.id === +tgt.dataset.optimize);
      const r = compute(state);
      const info = r.emps.find(x => x.e.id === emp.id);
      const totalCash = info.grossSalary + info.bonus;
      const best = optimizeSplit(totalCash, info.annPersSIHF, info.dedAnnual, state.params);
      const cur = info.iit + info.bTax;
      const hint = $(`[data-opthint="${emp.id}"]`);
      if (best.tax < cur - 0.5) {
        const newSalary = r2((totalCash - best.b) / emp.months);
        hint.innerHTML = t('emp.optBest', { s: fmt(newSalary), b: fmt(best.b), t: fmt(r2(best.tax)), d: fmt(r2(cur - best.tax)) })
          + ` <button class="btn-xs" data-applysplit="${emp.id}" data-b="${best.b}" data-ms="${newSalary}">${t('emp.optApply')}</button>`;
      } else {
        hint.textContent = t('emp.optAlready', { t: fmt(cur) });
      }
    } else if (tgt.dataset.applysplit) {
      const emp = state.employees.find(x => x.id === +tgt.dataset.applysplit);
      emp.bonus = num(tgt.dataset.b);
      emp.salary = num(tgt.dataset.ms);
      renderEmployees(); renderResults();
    }
  });

  $('#btnAddEmp').addEventListener('click', () => {
    state.employees.push(newEmployee({ name: `${t('emp.defaultName')}${state.employees.length + 1}` }));
    renderEmployees(); renderResults();
  });

  /* 快照 */
  $('#btnSnap').addEventListener('click', () => {
    const name = $('#snapName').value.trim() || `${t('snapDefault')}${state.snapshots.length + 1}`;
    state.snapshots.push({ name, data: compute(state) });
    $('#snapName').value = '';
    renderSnapshots();
  });
  $('#snapBox').addEventListener('click', e => {
    if (e.target.dataset.delsnap !== undefined) {
      state.snapshots.splice(+e.target.dataset.delsnap, 1);
      renderSnapshots();
    }
  });
}

/* ============================================================
 * 启动
 * ============================================================ */
(async function init() {
  presetOptimized();
  bindEvents();
  renderAll(); // 先渲染离线视图，避免等待网络
  await loadUsers();
  await Promise.all([loadRegions(), loadPlans(), loadParams()]);
  if (app.currentPlanId) {
    try { await loadPlanById(app.currentPlanId); return; } catch (e) { /* fall through */ }
  }
  renderAll();
})();

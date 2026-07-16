/* ============================================================
 * 企业主个人收入税务优化计算器
 * 适用：小规模纳税人（增值税 1% 征收率）+ 小微企业所得税优惠
 * 仅供测算参考，不构成税务建议
 * ============================================================ */

'use strict';

/* ---------- 工具函数 ---------- */
const r2 = v => Math.round(v * 100) / 100;
const fmt = n => (isFinite(n) ? n : 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt0 = n => (isFinite(n) ? n : 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 });
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const $ = sel => document.querySelector(sel);
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };

/* ---------- 税率表 ---------- */
// 综合所得年度税率表（工资薪金）
const IIT_BRACKETS = [
  [36000, 0.03, 0],
  [144000, 0.10, 2520],
  [300000, 0.20, 16920],
  [420000, 0.25, 31920],
  [660000, 0.30, 52920],
  [960000, 0.35, 85920],
  [Infinity, 0.45, 181920],
];

// 年终奖单独计税（按月换算税率表）
const BONUS_BRACKETS = [
  [3000, 0.03, 0],
  [12000, 0.10, 210],
  [25000, 0.20, 1410],
  [35000, 0.25, 2660],
  [55000, 0.30, 4410],
  [80000, 0.35, 7160],
  [Infinity, 0.45, 15160],
];

function iitAnnual(taxable) {
  if (taxable <= 0) return 0;
  for (const [lim, rate, ded] of IIT_BRACKETS) {
    if (taxable <= lim) return taxable * rate - ded;
  }
}

function bonusTax(bonus) {
  if (bonus <= 0) return 0;
  const monthly = bonus / 12;
  for (const [lim, rate, ded] of BONUS_BRACKETS) {
    if (monthly <= lim) return bonus * rate - ded;
  }
}

/* ---------- 专项附加扣除项定义（月标准额） ---------- */
const DEDUCTION_DEFS = [
  { key: 'rent',  label: '住房租金',       def: 1500 },
  { key: 'loan',  label: '房贷利息',       def: 1000 },
  { key: 'child', label: '子女教育',       def: 2000 },
  { key: 'baby',  label: '3岁以下婴幼儿',  def: 2000 },
  { key: 'elder', label: '赡养老人',       def: 3000 },
  { key: 'edu',   label: '继续教育',       def: 400 },
];

/* ---------- 状态 ---------- */
let empSeq = 0;

function newEmployee(over = {}) {
  const ded = {};
  DEDUCTION_DEFS.forEach(d => { ded[d.key] = { on: false, amt: d.def }; });
  return Object.assign({
    id: ++empSeq,
    name: '员工',
    salary: 10000,
    months: 12,
    hasSI: true,
    base: 10000,          // 社保/公积金缴费基数（两者共用）
    hfRate: 7,            // 基础公积金比例 %
    hfExtra: 0,           // 补充公积金比例 %
    bonus: 0,             // 年终奖（单独计税）
    family: false,        // 计入家庭收益
    ded,
  }, over);
}

const state = {
  vatRate: 1,             // 增值税征收率 %
  surchargeRate: 12,      // 附加税占增值税比例 %
  quarterMode: 'custom',  // 'avg' 平均开票 | 'custom' 按季自定义
  annualRevenue: 1800000, // 平均模式下的年含税收入
  quarters: [290000, 290000, 290000, 930000],
  si: { compRate: 25.7, persRate: 10.5, capBase: 37302, floorBase: 7384 },
  rentReimburse: 10000,   // 房租报销 元/月
  otherCost: 0,           // 其他年度成本
  distributeDividend: false,
  employees: [],
  snapshots: [],
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
  const boss = newEmployee({ name: 'A（老板）', salary: 23000, base: 37302, hfRate: 7, hfExtra: 5, bonus: 36000, family: true });
  state.employees = [
    boss,
    newEmployee({ name: 'B', salary: 30000, base: 30000, hfRate: 7, hfExtra: 0 }),
    newEmployee({ name: 'C（女儿·实习）', salary: 5000, hasSI: false, hfRate: 0, family: true }),
    newEmployee({ name: '实习生D', salary: 5000, hasSI: false, hfRate: 0 }),
  ];
}

/* ---------- 核心计算 ---------- */
function compute(s) {
  // ── 增值税（按季判断免税：季度不含税销售额 ≤ 30 万免征） ──
  const vatR = s.vatRate / 100;
  const quarters = s.quarterMode === 'avg'
    ? Array(4).fill(s.annualRevenue / 4)
    : s.quarters.map(num);
  let vat = 0, incomeNet = 0;
  const qDetails = quarters.map((gross, i) => {
    const net = gross / (1 + vatR);
    if (net <= 300000 + 1e-6) {
      incomeNet += gross;                       // 免税，价税全额确认收入
      return { q: i + 1, gross, net: gross, vat: 0, exempt: true };
    }
    const v = r2(net * vatR);
    vat += v;
    incomeNet += net;
    return { q: i + 1, gross, net: r2(net), vat: v, exempt: false };
  });
  vat = r2(vat);
  const surcharge = r2(vat * s.surchargeRate / 100);
  const totalGross = quarters.reduce((a, b) => a + b, 0);

  // ── 人员：社保公积金 + 个税 ──
  const emps = s.employees.map(e => {
    const base = clamp(num(e.base), 0, Infinity);
    const hfR = (num(e.hfRate) + num(e.hfExtra)) / 100;
    const mCompSI = e.hasSI ? r2(base * s.si.compRate / 100) : 0;
    const mPersSI = e.hasSI ? r2(base * s.si.persRate / 100) : 0;
    const mCompHF = e.hasSI ? r2(base * hfR) : 0;
    const mPersHF = e.hasSI ? r2(base * hfR) : 0;
    const annCompSIHF = r2((mCompSI + mCompHF) * e.months);
    const annPersSIHF = r2((mPersSI + mPersHF) * e.months);

    let dedAnnual = 0;
    DEDUCTION_DEFS.forEach(d => { if (e.ded[d.key].on) dedAnnual += num(e.ded[d.key].amt) * 12; });

    const grossSalary = num(e.salary) * e.months;
    const bonus = num(e.bonus);
    const taxable = grossSalary - 60000 - annPersSIHF - dedAnnual;
    const iit = r2(iitAnnual(taxable));
    const bTax = r2(bonusTax(bonus));
    const netCash = r2(grossSalary + bonus - annPersSIHF - iit - bTax);
    const hfTotal = r2((mCompHF + mPersHF) * e.months);   // 公积金账户入账（双边）

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

  // ── 企业所得税（小微：≤300万部分按 25% 计入 × 20% = 5%） ──
  const totalCost = r2(laborCost + rentAnnual + num(s.otherCost) + surcharge);
  const profit = r2(incomeNet - totalCost);
  let cit = 0, citRateLabel = '5%（小微优惠）';
  if (profit > 0) {
    if (profit <= 3000000) cit = r2(profit * 0.05);
    else { cit = r2(profit * 0.25); citRateLabel = '25%（超小微标准）'; }
  }
  const profitAfter = r2(profit - cit);

  // ── 分红（可选，20% 股息红利个税） ──
  const divTax = s.distributeDividend && profitAfter > 0 ? r2(profitAfter * 0.20) : 0;
  const divNet = s.distributeDividend ? r2(profitAfter - divTax) : 0;

  // ── 家庭收益（勾选“计入家庭”的成员 + 报销 + 分红） ──
  const famEmps = emps.filter(x => x.e.family);
  const famCash = r2(famEmps.reduce((a, x) => a + x.netCash, 0));
  const famHF = r2(famEmps.reduce((a, x) => a + x.hfTotal, 0));
  const famTotal = r2(famCash + famHF + rentAnnual + divNet);

  const totalTax = r2(vat + surcharge + cit + totalIIT + divTax);

  return {
    quarters, qDetails, vat, surcharge, totalGross, incomeNet,
    emps, laborCost, totalCompSIHF, totalIIT, rentAnnual,
    totalCost, profit, cit, citRateLabel, profitAfter, divTax, divNet,
    famCash, famHF, famTotal, totalTax,
    taxRate: totalGross > 0 ? totalTax / totalGross : 0,
  };
}

/* ---------- 工资 / 年终奖拆分优化 ---------- */
function optimizeSplit(totalCash, annPersSIHF, dedAnnual) {
  const taxOf = b => {
    const taxable = (totalCash - b) - 60000 - annPersSIHF - dedAnnual;
    return iitAnnual(Math.max(taxable, 0)) + bonusTax(b);
  };
  let best = { b: 0, tax: taxOf(0) };
  const candidates = new Set([0, 36000, 144000, 300000, 420000, 660000, 960000, totalCash]);
  for (let b = 0; b <= totalCash; b += 500) candidates.add(b);
  for (const b of candidates) {
    if (b < 0 || b > totalCash) continue;
    const t = taxOf(b);
    if (t < best.tax - 0.005) best = { b, tax: t };
  }
  return best;
}

/* ---------- 渲染：员工卡片 ---------- */
function renderEmployees() {
  const wrap = $('#empList');
  wrap.innerHTML = state.employees.map(e => {
    const dedChips = DEDUCTION_DEFS.map(d => `
      <label class="chip ${e.ded[d.key].on ? 'on' : ''}">
        <input type="checkbox" data-emp="${e.id}" data-ded="${d.key}" ${e.ded[d.key].on ? 'checked' : ''}>
        ${d.label}
        <input type="number" class="chip-amt" data-emp="${e.id}" data-dedamt="${d.key}"
               value="${e.ded[d.key].amt}" ${e.ded[d.key].on ? '' : 'disabled'}> 元/月
      </label>`).join('');
    return `
    <div class="card emp-card" data-empcard="${e.id}">
      <div class="emp-head">
        <input class="emp-name" data-emp="${e.id}" data-f="name" value="${e.name}">
        <label class="mini"><input type="checkbox" data-emp="${e.id}" data-f="family" ${e.family ? 'checked' : ''}>计入家庭收益</label>
        <button class="btn-del" data-del="${e.id}" title="删除">✕</button>
      </div>
      <div class="grid3">
        <label>月薪（元）<input type="number" data-emp="${e.id}" data-f="salary" value="${e.salary}"></label>
        <label>发放月数<input type="number" data-emp="${e.id}" data-f="months" value="${e.months}" min="1" max="12"></label>
        <label>年终奖（元）<input type="number" data-emp="${e.id}" data-f="bonus" value="${e.bonus}"></label>
      </div>
      <div class="grid3">
        <label class="mini si-toggle"><input type="checkbox" data-emp="${e.id}" data-f="hasSI" ${e.hasSI ? 'checked' : ''}>缴纳社保公积金</label>
        <label>缴费基数
          <span class="base-row">
            <input type="number" data-emp="${e.id}" data-f="base" value="${e.base}" ${e.hasSI ? '' : 'disabled'}>
            <button class="btn-xs" data-basecap="${e.id}" ${e.hasSI ? '' : 'disabled'}>顶格</button>
            <button class="btn-xs" data-basesalary="${e.id}" ${e.hasSI ? '' : 'disabled'}>按工资</button>
          </span>
        </label>
        <label>公积金比例（%）
          <span class="base-row">
            <input type="number" data-emp="${e.id}" data-f="hfRate" value="${e.hfRate}" ${e.hasSI ? '' : 'disabled'} title="基础比例"> +
            <input type="number" data-emp="${e.id}" data-f="hfExtra" value="${e.hfExtra}" ${e.hasSI ? '' : 'disabled'} title="补充比例">
          </span>
        </label>
      </div>
      <details class="ded-box">
        <summary>专项附加扣除（房贷与房租不可同时享受）</summary>
        <div class="chips">${dedChips}</div>
      </details>
      <div class="opt-row">
        <button class="btn-secondary" data-optimize="${e.id}">工资/年终奖拆分优化</button>
        <span class="opt-hint" data-opthint="${e.id}"></span>
      </div>
    </div>`;
  }).join('');
}

/* ---------- 渲染：季度开票输入 ---------- */
function renderQuarters() {
  const box = $('#quarterBox');
  const isCustom = state.quarterMode === 'custom';
  $('#annualRevWrap').style.display = isCustom ? 'none' : '';
  box.style.display = isCustom ? '' : 'none';
  if (isCustom) {
    box.querySelectorAll('input[data-q]').forEach(inp => {
      inp.value = state.quarters[+inp.dataset.q];
    });
    const sum = state.quarters.reduce((a, b) => a + num(b), 0);
    $('#qSum').textContent = `四季合计：${fmt(sum)} 元`;
  }
}

/* ---------- 渲染：结果 ---------- */
function renderResults() {
  const r = compute(state);

  $('#kpis').innerHTML = `
    <div class="kpi"><span>税费总额</span><b>¥ ${fmt(r.totalTax)}</b></div>
    <div class="kpi"><span>综合税负率</span><b>${(r.taxRate * 100).toFixed(2)}%</b></div>
    <div class="kpi"><span>公司税后利润</span><b>¥ ${fmt(r.profitAfter)}</b></div>
    <div class="kpi"><span>家庭年收益合计</span><b>¥ ${fmt(r.famTotal)}</b></div>`;

  $('#vatTable').innerHTML = `
    <tr><th>季度</th><th>开票额（含税）</th><th>不含税销售额</th><th>增值税</th><th>状态</th></tr>
    ${r.qDetails.map(q => `<tr>
      <td>Q${q.q}</td><td>${fmt(q.gross)}</td><td>${fmt(q.net)}</td>
      <td>${fmt(q.vat)}</td>
      <td>${q.exempt ? '<span class="tag ok">免税</span>' : '<span class="tag">征税</span>'}</td>
    </tr>`).join('')}
    <tr class="total"><td>合计</td><td>${fmt(r.totalGross)}</td><td>${fmt(r.incomeNet)}</td><td>${fmt(r.vat)}</td><td></td></tr>
    <tr class="total"><td colspan="3">附加税（增值税 × ${state.surchargeRate}%）</td><td>${fmt(r.surcharge)}</td><td></td></tr>`;

  $('#empTable').innerHTML = `
    <tr><th>姓名</th><th>年薪+奖金</th><th>公司社保公积金</th><th>个人社保公积金</th><th>个税(含奖金)</th><th>到手现金</th><th>公积金入账</th></tr>
    ${r.emps.map(x => `<tr>
      <td>${x.e.name}${x.e.family ? ' <span class="tag fam">家庭</span>' : ''}</td>
      <td>${fmt(x.grossSalary + x.bonus)}</td>
      <td>${fmt(x.annCompSIHF)}</td>
      <td>${fmt(x.annPersSIHF)}</td>
      <td>${fmt(x.iit + x.bTax)}</td>
      <td>${fmt(x.netCash)}</td>
      <td>${fmt(x.hfTotal)}</td>
    </tr>`).join('')}
    <tr class="total"><td>合计</td>
      <td>${fmt(r.emps.reduce((a, x) => a + x.grossSalary + x.bonus, 0))}</td>
      <td>${fmt(r.totalCompSIHF)}</td>
      <td>${fmt(r.emps.reduce((a, x) => a + x.annPersSIHF, 0))}</td>
      <td>${fmt(r.totalIIT)}</td>
      <td>${fmt(r.emps.reduce((a, x) => a + x.netCash, 0))}</td>
      <td>${fmt(r.emps.reduce((a, x) => a + x.hfTotal, 0))}</td></tr>`;

  $('#citBox').innerHTML = `
    <div class="line"><span>不含税收入（含免税额）</span><b>${fmt(r.incomeNet)}</b></div>
    <div class="line"><span>− 人工总成本（工资+奖金+公司社保公积金）</span><b>${fmt(r.laborCost)}</b></div>
    <div class="line"><span>− 房租报销</span><b>${fmt(r.rentAnnual)}</b></div>
    <div class="line"><span>− 其他成本</span><b>${fmt(num(state.otherCost))}</b></div>
    <div class="line"><span>− 附加税</span><b>${fmt(r.surcharge)}</b></div>
    <div class="line em"><span>= 应纳税所得额</span><b>${fmt(r.profit)}</b></div>
    <div class="line"><span>企业所得税 · ${r.citRateLabel}</span><b>${fmt(r.cit)}</b></div>
    <div class="line em"><span>税后利润</span><b>${fmt(r.profitAfter)}</b></div>
    ${state.distributeDividend ? `
      <div class="line"><span>分红个税（20%）</span><b>${fmt(r.divTax)}</b></div>
      <div class="line em"><span>分红到手</span><b>${fmt(r.divNet)}</b></div>` : ''}`;

  $('#famBox').innerHTML = `
    <div class="line"><span>家庭成员税后现金（工资+奖金）</span><b>${fmt(r.famCash)}</b></div>
    <div class="line"><span>家庭成员公积金入账（双边）</span><b>${fmt(r.famHF)}</b></div>
    <div class="line"><span>房租报销</span><b>${fmt(r.rentAnnual)}</b></div>
    <div class="line"><span>分红到手</span><b>${fmt(r.divNet)}</b></div>
    <div class="line em"><span>家庭年收益合计</span><b>${fmt(r.famTotal)}</b></div>
    <div class="line dim"><span>公司留存税后利润（未分红部分）</span><b>${fmt(state.distributeDividend ? 0 : r.profitAfter)}</b></div>`;

  $('#taxBox').innerHTML = `
    <div class="line"><span>增值税</span><b>${fmt(r.vat)}</b></div>
    <div class="line"><span>附加税</span><b>${fmt(r.surcharge)}</b></div>
    <div class="line"><span>企业所得税</span><b>${fmt(r.cit)}</b></div>
    <div class="line"><span>个人所得税（全员，含年终奖）</span><b>${fmt(r.totalIIT)}</b></div>
    ${state.distributeDividend ? `<div class="line"><span>分红个税</span><b>${fmt(r.divTax)}</b></div>` : ''}
    <div class="line em"><span>税费总额</span><b>${fmt(r.totalTax)}</b></div>
    <div class="line dim"><span>公司承担社保公积金（非税，部分沉淀为个人权益）</span><b>${fmt(r.totalCompSIHF)}</b></div>`;

  renderSnapshots();
}

/* ---------- 方案快照对比 ---------- */
function renderSnapshots() {
  const box = $('#snapBox');
  if (!state.snapshots.length) { box.innerHTML = '<p class="dim">暂无快照。调整参数后点击「保存当前方案」，可保存多个方案进行对比。</p>'; return; }
  const rows = [
    ['税费总额', s => fmt(s.totalTax)],
    ['增值税+附加', s => fmt(r2(s.vat + s.surcharge))],
    ['企业所得税', s => fmt(s.cit)],
    ['个税合计', s => fmt(s.totalIIT)],
    ['公司社保公积金', s => fmt(s.totalCompSIHF)],
    ['公司税后利润', s => fmt(s.profitAfter)],
    ['家庭年收益', s => fmt(s.famTotal)],
    ['综合税负率', s => (s.taxRate * 100).toFixed(2) + '%'],
  ];
  box.innerHTML = `<table class="tbl">
    <tr><th></th>${state.snapshots.map((s, i) => `<th>${s.name} <button class="btn-del btn-xs" data-delsnap="${i}">✕</button></th>`).join('')}</tr>
    ${rows.map(([label, f]) => `<tr><td>${label}</td>${state.snapshots.map(s => `<td>${f(s.data)}</td>`).join('')}</tr>`).join('')}
  </table>`;
}

/* ---------- 表单同步 ---------- */
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

function loadPreset(which) {
  which === 'original' ? presetOriginal() : presetOptimized();
  syncTopForm();
  renderEmployees();
  renderResults();
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  // 顶部预设
  $('#btnOriginal').addEventListener('click', () => loadPreset('original'));
  $('#btnOptimized').addEventListener('click', () => loadPreset('optimized'));

  // 公司参数（简单字段 → state 路径）
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
      const sum = state.quarters.reduce((a, b) => a + num(b), 0);
      $('#qSum').textContent = `四季合计：${fmt(sum)} 元`;
      renderResults();
    });
  });
  $('#btnQOptimize').addEventListener('click', () => {
    // 前三季各开 30 万（免税上限），剩余放入第四季度
    const total = state.quarterMode === 'avg'
      ? state.annualRevenue
      : state.quarters.reduce((a, b) => a + num(b), 0);
    const per = Math.min(300000, total / 4);
    const q4 = r2(total - per * 3);
    state.quarters = [per, per, per, q4];
    state.quarterMode = 'custom';
    syncTopForm();
    renderResults();
  });

  // 员工区（事件委托）
  $('#empList').addEventListener('input', e => {
    const t = e.target;
    const emp = state.employees.find(x => x.id === +t.dataset.emp);
    if (!emp) return;
    if (t.dataset.f) {
      const f = t.dataset.f;
      if (f === 'name') emp.name = t.value;
      else if (f === 'family' || f === 'hasSI') emp[f] = t.checked;
      else emp[f] = num(t.value);
      if (f === 'hasSI') renderEmployees();
    } else if (t.dataset.ded) {
      emp.ded[t.dataset.ded].on = t.checked;
      renderEmployees();
    } else if (t.dataset.dedamt) {
      emp.ded[t.dataset.dedamt].amt = num(t.value);
    }
    renderResults();
  });

  $('#empList').addEventListener('click', e => {
    const t = e.target;
    if (t.dataset.del) {
      state.employees = state.employees.filter(x => x.id !== +t.dataset.del);
      renderEmployees(); renderResults();
    } else if (t.dataset.basecap) {
      const emp = state.employees.find(x => x.id === +t.dataset.basecap);
      emp.base = state.si.capBase;
      renderEmployees(); renderResults();
    } else if (t.dataset.basesalary) {
      const emp = state.employees.find(x => x.id === +t.dataset.basesalary);
      emp.base = clamp(emp.salary, state.si.floorBase, state.si.capBase);
      renderEmployees(); renderResults();
    } else if (t.dataset.optimize) {
      const emp = state.employees.find(x => x.id === +t.dataset.optimize);
      const r = compute(state);
      const info = r.emps.find(x => x.e.id === emp.id);
      const totalCash = info.grossSalary + info.bonus;
      const best = optimizeSplit(totalCash, info.annPersSIHF, info.dedAnnual);
      const cur = info.iit + info.bTax;
      const hint = $(`[data-opthint="${emp.id}"]`);
      if (best.tax < cur - 0.5) {
        const newSalary = r2((totalCash - best.b) / emp.months);
        hint.innerHTML = `建议：月薪 <b>${fmt(newSalary)}</b> + 年终奖 <b>${fmt(best.b)}</b>，个税 ${fmt(r2(best.tax))}（省 ${fmt(r2(cur - best.tax))}）
          <button class="btn-xs" data-applysplit="${emp.id}" data-b="${best.b}" data-ms="${newSalary}">应用</button>`;
      } else {
        hint.textContent = `当前拆分已接近最优（个税 ${fmt(cur)}）`;
      }
    } else if (t.dataset.applysplit) {
      const emp = state.employees.find(x => x.id === +t.dataset.applysplit);
      emp.bonus = num(t.dataset.b);
      emp.salary = num(t.dataset.ms);
      renderEmployees(); renderResults();
    }
  });

  $('#btnAddEmp').addEventListener('click', () => {
    state.employees.push(newEmployee({ name: `员工${state.employees.length + 1}` }));
    renderEmployees(); renderResults();
  });

  // 快照
  $('#btnSnap').addEventListener('click', () => {
    const name = $('#snapName').value.trim() || `方案${state.snapshots.length + 1}`;
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

/* ---------- 启动 ---------- */
presetOptimized();
bindEvents();
syncTopForm();
renderEmployees();
renderResults();

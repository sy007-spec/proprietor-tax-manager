/* 计算引擎回归测试：stub 浏览器环境后加载 public/app.js 的计算部分，
 * 对照用户手算基准逐项断言。运行：node tests/regression.js（或 python ops.py test） */
const fs = require('fs');
const path = require('path');

global.window = {};
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.document = { querySelector: () => null, querySelectorAll: () => [], documentElement: {} };
global.fetch = () => Promise.reject(new TypeError('offline'));

const PUB = path.join(__dirname, '..', 'public');
eval(fs.readFileSync(path.join(PUB, 'i18n.js'), 'utf8').replace("'use strict';", ''));
global.I18N = window.I18N;

let src = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const cut = src.indexOf('/* ============================================================\n * 渲染');
if (cut < 0) { console.error('FAIL 无法定位渲染分节标记'); process.exit(1); }
src = src.slice(0, cut)
  .replace("'use strict';", '')
  .replace('let lang =', 'var lang =')
  .replace('let empSeq = 0;', 'var empSeq = 0;')
  .replace('const state = {', 'var state = {');
eval(src);

let fails = 0;
const ck = (label, got, want, tol = 0.05) => {
  const pass = Math.abs(got - want) <= tol;
  if (!pass) fails++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}: got=${got.toFixed(2)} want=${want}`);
};

console.log('--- 原始方案 ---');
presetOriginal();
let r = compute(state);
ck('增值税(按季舍入)', r.vat, 17821.80);
ck('附加税', r.surcharge, 2138.62);
ck('A 公司社保年', r.emps[0].mCompSI * 12, 115039.32);
ck('A 公积金年(公司)', r.emps[0].mCompHF * 12, 53714.88);
ck('公司社保公积金合计', r.totalCompSIHF, 286474.2);
ck('人工总成本', r.laborCost, 1366474.2);
ck('企业所得税', r.cit, (415704.02 - 2138.62) * 0.05, 0.1);
ck('A 个税', r.emps[0].iit, (720000 - 60000 - 8392.95 * 12) * 0.30 - 52920);

console.log('--- 优化方案 ---');
presetOptimized();
r = compute(state);
ck('增值税', r.vat, 9207.92);
ck('附加税', r.surcharge, 1104.95);
ck('免税季数', r.qDetails.filter(q => q.exempt).length, 3, 0);
ck('税费总额', r.totalTax, 80441.98);
ck('家庭年收益', r.famTotal, 488625.90);
ck('年终奖36000税', bonusTax(36000, state.params.bonus_brackets), 1080);
ck('年终奖36001跳档', bonusTax(36001, state.params.bonus_brackets), 3390.1);

console.log('--- 参数可调性 ---');
state.params.cit.smallRate = 2.5;
r = compute(state);
ck('小微税率改2.5%后CIT', r.cit, r.profit * 0.025);
state.params.vat.exemptQuarterly = 200000;
r = compute(state);
ck('免税额度20万后免税季数', r.qDetails.filter(q => q.exempt).length, 0, 0);
state.params.vat.exemptQuarterly = 300000;
state.params.cit.smallRate = 5;
state.params.personal.basicDeduction = 70000;
r = compute(state);
ck('基本减除7万后B应纳税所得额', r.emps[1].taxable, 360000 - 70000 - 63000);
state.params.personal.basicDeduction = 60000;

console.log('--- 拆分优化器 ---');
r = compute(state);
const ai = r.emps[0];
const best = optimizeSplit(ai.grossSalary + ai.bonus, ai.annPersSIHF, ai.dedAnnual, state.params);
ck('当前拆分即最优', ai.iit + ai.bTax, best.tax, 0.01);

console.log(fails === 0 ? '\n全部通过 ✔' : `\n${fails} 项失败 ✘`);
process.exit(fails === 0 ? 0 : 1);

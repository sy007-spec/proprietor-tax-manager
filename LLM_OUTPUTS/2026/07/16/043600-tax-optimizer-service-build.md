# 税务优化计算服务搭建（SPA → Node+SQLite 全栈服务）

- source: claude-code
- model: claude-fable-5
- archived_at: 2026-07-16T04:36:00

## Output

本次会话交付（两轮）：

### 第一轮：纯前端 SPA
- 原生 JS 计算器：增值税季度免税筹划、社保公积金、个税专项附加扣除、年终奖单独计税与拆分寻优、小微企业所得税、家庭收益归集、方案快照对比。
- 内置「原始方案 / 优化方案」预设（A 老板 6万→2.3万+3.6万年终奖、B 3万、C 女儿实习 5000、实习生 D 5000、房租报销 1万/月、29万×3+93万开票节奏）。
- 计算引擎经 Node 回归脚本对照用户手算数字逐项验证通过；优化方案全年税费 80,441.98 元（税负率 4.47%），较原始方案约省 10.5 万元/年。

### 第二轮：升级为体系化服务
- 零依赖后端 `server.js`（Node http + node:sqlite，端口 8787）。
- SQLite：regions（地区基数，(code,period) 幂等 upsert + sync_log 留痕 + 事务回滚）、users、plans（(user_id,name) upsert）、params（全局默认 + 用户覆盖）。
- 基础数据集 data/base-data.json v2025.1：上海（社保 7460–37302、社平 12434、公积金上限 37302/下限 2690，官方来源）+ 京广深杭。支持远程数据源 URL 同步。
- 前端：中英文切换（i18n.js）、多用户/多方案保存切换、地区数据一键同步与应用、税制参数模块化编辑（个税/年终奖税率表、企业所得税档位、免税额度、基本减除、股息税率）、实时预览；服务器不可达时自动降级离线单机模式。
- 端到端验证：API 幂等性（重复同步 0/0/5）、用户/方案/参数 CRUD、计算回归 19 项全通过、headless Chrome 页面冒烟 10 项全通过。

### 待用户决策
- PROJECT_LLM_REQUIREMENTS.json 中 `enforce_english_ui_only: true` 与用户本轮明确要求的中英双语切换冲突，按用户直接指令保留双语，未执行 English-only。
- tools/archive_llm_output.py 存在 `\n` 字面量 bug（render_markdown/slugify 中双反斜杠），归档文件为手写。

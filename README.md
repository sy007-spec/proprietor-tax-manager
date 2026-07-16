# 企业主收入税务优化计算服务 / Proprietor Income Tax Optimizer

面向中国小规模纳税人企业主的个人收入税务优化测算服务：增值税季度免税筹划、社保公积金、个税专项附加扣除、年终奖拆分优化、小微企业所得税、家庭收益汇总，支持实时预览、多用户、多方案、中英文。

## 运行与运维（统一入口 ops.py）

零外部依赖（Node ≥ 22.5 内置 `node:sqlite`；ops.py 仅用 Python 标准库）：

```bash
python ops.py            # 默认 = restart（iron-rules 约定）
python ops.py start      # 后台启动 → http://localhost:8787（PID + 日志 + 健康检查）
python ops.py dev        # 前台开发模式（node --watch 热重载）
python ops.py status     # 运行状态 + 数据库概况
python ops.py deploy     # macOS launchd 常驻（开机自启、崩溃拉起）；undeploy 卸载
python ops.py sync       # 幂等同步地区基础数据（可 --url 远程数据源）
python ops.py param get|set|reset [--user N]   # 调整税制参数
python ops.py backup / restore <file>          # SQLite 在线备份 / 停服恢复
python ops.py test       # 计算引擎回归测试（tests/regression.js）
python ops.py doctor     # 环境体检
python ops.py uninstall [--purge]              # 卸载（--purge 连数据一并删除）
```

首次启动自动建库（`data/taxmgr.db`）并灌入内置基础数据集。前端也可直接以 `public/index.html` 单机离线打开（用户/方案/基础数据功能不可用，计算功能完整）。

## 功能

- **地区基础数据（SQLite）**：全国主要城市社保/公积金缴费基数上下限、社平工资，含生效期与官方来源。「一键同步」幂等可重入：按 `(code, period)` 主键 upsert，逐字段比对，无变化跳过，事务保护，`sync_log` 留痕。支持远程数据源（`POST /api/sync {"url": "https://..."}`）。
- **计算引擎**：增值税按季免税判定（不含税额 ≤ 免税额度）、附加税、社保公积金（基数/比例/补充公积金全可调）、个税累进（专项附加扣除六项）、年终奖单独计税 + 拆分寻优、小微企业所得税、股息分红税、家庭收益归集。所有输入实时重算。
- **税制参数模块化**：个税税率表、年终奖税率表、企业所得税档位、增值税免税额度、基本减除、股息税率均可编辑，按用户保存到服务器（覆盖全局默认），随方案存档。
- **用户 / 方案体系**：多用户切换，方案（完整参数快照）保存/另存/切换/删除，同名 upsert；会话内快照对比表。
- **中英文切换**：右上角一键切换，全界面即时生效。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/health | 健康检查 |
| GET | /api/regions[?all=1] | 地区基础数据（默认各地最新年度） |
| POST | /api/sync | 幂等同步基础数据（可选 body: `{url}` 远程数据源） |
| GET | /api/sync/log | 同步日志 |
| GET/POST | /api/users | 用户列表 / 创建 |
| PUT/DELETE | /api/users/:id | 更新（name/lang/region）/ 删除 |
| GET/POST | /api/users/:id/plans | 方案列表 / 保存（按名称 upsert） |
| GET/DELETE | /api/plans/:id | 方案详情（含完整 state）/ 删除 |
| GET | /api/params?user=:id | 税制参数（全局默认 + 用户覆盖合并） |
| PUT | /api/params | 保存参数 `{user_id, key, value}` |
| POST | /api/params/reset | 重置参数 `{user_id}`（0 = 重置全局默认） |

## 数据更新

各地基数每年 7 月前后调整（公告常滞后至 9 月并追溯）。更新 `data/base-data.json`（提升 `version`，新增新 `period` 记录）后点击「一键同步」即可；旧年度数据保留可查（`?all=1`）。

## 免责声明

仅供测算参考。税率与政策（小规模 1% 征收率、季度免税额度、小微 5%、年终奖单独计税等）均有适用期限与地区差异，实际申报以主管税务机关口径为准。亲属/实习生用工需真实任职受雇，虚列工资属偷逃税行为。

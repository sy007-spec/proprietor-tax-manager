# ops.py 统一运维入口实现

- source: claude-code
- model: claude-fable-5
- archived_at: 2026-07-16T04:46:00

## Output

将占位的 ops.py 扩为完整统一运维入口（Python 标准库，零依赖），并新增 tests/regression.js（回归测试入仓）：

- 生命周期：init / start / stop / restart（默认命令，iron-rules 约定）/ status / dev（--watch 热重载）/ logs（-f 跟踪）
- 部署：deploy（macOS launchd 常驻，开机自启+崩溃拉起）/ undeploy
- 数据与调整：sync（服务在跑走 API、停服直连 SQLite，均幂等）/ param get|set|reset（税制参数分用户调整）/ config（本地运维配置 ops.config.json）/ backup（sqlite 在线备份 API）/ restore（完整性校验→停服→恢复→原状态拉起）
- 质量：test（19 项计算回归）/ doctor（node 版本、端口健康、SQLite integrity_check、submodule、数据集版本）
- 卸载：uninstall [--purge]（撤部署+停服+清运行文件；--purge 带确认删数据库与备份）

实测通过：stop 端口兜底杀孤儿进程、start/restart/status、sync 幂等（0/0/5）、param 改小微税率 2.5% 并重置、backup→restore round-trip、无参数默认 restart、停服状态 status/doctor（修复 WAL 库只读打开回退：ro → immutable → plain）、deploy→launchd 拉起→undeploy round-trip、test 全过、doctor 全绿。

.gitignore 增加 logs/、backups/、ops.config.json、data/server.pid。

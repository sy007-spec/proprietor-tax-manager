#!/usr/bin/env python3
"""
统一运维入口（project-iron-core 约定：python ops.py restart）

用法：
  python ops.py <command> [options]

生命周期
  init                 环境检查 + 建库灌数据 + git submodule 初始化
  start [--port P]     后台启动服务（PID 文件 + 日志 + 健康检查）
  stop                 停止服务（PID 优先，端口兜底）
  restart [--port P]   重启（默认命令）
  status               运行状态 + 健康检查 + 数据库概况
  dev                  前台开发模式（node --watch 热重载，Ctrl-C 退出）
  logs [-n N] [-f]     查看/跟踪服务日志

部署
  deploy [--port P]    安装 macOS launchd 常驻服务（开机自启、崩溃拉起）
  undeploy             卸载 launchd 服务（保留数据）

数据与调整
  sync [--url U]       幂等同步地区基础数据（服务在跑走 API，否则直连 SQLite）
  param get [--user N]                查看税制参数（全局默认+用户覆盖合并）
  param set <key> <json> [--user N]   调整参数（如 cit / vat / personal / iit_brackets）
  param reset [--user N]              重置参数
  config get|set <k> <v>              本地运维配置（port 等，存 ops.config.json）
  backup               在线安全备份 SQLite 到 backups/
  restore <file>       停服恢复备份

质量
  test                 计算引擎回归测试（tests/regression.js）
  doctor               环境体检（node 版本、端口、DB 完整性、submodule）

卸载
  uninstall [--purge] [--yes]  停服 + 撤销部署 + 清理运行文件；--purge 连数据库/备份一并删除
"""

from __future__ import annotations

import argparse
import json
import os
import plistlib
import shutil
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
LOG_DIR = ROOT / "logs"
BACKUP_DIR = ROOT / "backups"
PID_FILE = DATA_DIR / "server.pid"
LOG_FILE = LOG_DIR / "server.log"
DB_FILE = DATA_DIR / "taxmgr.db"
CONFIG_FILE = ROOT / "ops.config.json"
LAUNCHD_LABEL = "com.proprietor-tax-manager.server"
LAUNCHD_PLIST = Path.home() / "Library" / "LaunchAgents" / f"{LAUNCHD_LABEL}.plist"
DEFAULT_PORT = 8787
MIN_NODE = (22, 5)


# ---------- 基础工具 ----------

def info(msg: str) -> None:
    print(f"[ops] {msg}")


def fail(msg: str) -> int:
    print(f"[ops] ERROR: {msg}", file=sys.stderr)
    return 1


def load_config() -> dict:
    if CONFIG_FILE.exists():
        try:
            return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            info(f"警告：{CONFIG_FILE.name} 不是有效 JSON，按默认配置处理")
    return {}


def save_config(cfg: dict) -> None:
    CONFIG_FILE.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def get_port(args) -> int:
    if getattr(args, "port", None):
        return args.port
    return int(load_config().get("port", DEFAULT_PORT))


def node_bin() -> str | None:
    return shutil.which("node")


def node_version() -> tuple[int, ...] | None:
    node = node_bin()
    if not node:
        return None
    out = subprocess.run([node, "--version"], capture_output=True, text=True).stdout.strip()
    return tuple(int(x) for x in out.lstrip("v").split("."))


def http_json(method: str, url: str, body: dict | None = None, timeout: float = 20):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def read_pid() -> int | None:
    try:
        pid = int(PID_FILE.read_text().strip())
    except (FileNotFoundError, ValueError):
        return None
    if alive(pid):
        return pid
    PID_FILE.unlink(missing_ok=True)
    return None


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def pids_on_port(port: int) -> list[int]:
    out = subprocess.run(["lsof", "-ti", f"tcp:{port}", "-sTCP:LISTEN"],
                         capture_output=True, text=True).stdout.split()
    return [int(p) for p in out]


def health(port: int) -> bool:
    try:
        return bool(http_json("GET", f"http://127.0.0.1:{port}/api/health", timeout=3).get("ok"))
    except Exception:
        return False


def wait_health(port: int, seconds: float = 15) -> bool:
    deadline = time.time() + seconds
    while time.time() < deadline:
        if health(port):
            return True
        time.sleep(0.4)
    return False


def open_db_ro(path: Path) -> sqlite3.Connection:
    """只读打开 SQLite。WAL 库在无 -shm 时 mode=ro 会失败，逐级回退：
    ro → immutable（静态文件安全）→ 普通打开（仅执行只读语句）。"""
    p = Path(path).resolve()
    for uri in (f"file:{p}?mode=ro", f"file:{p}?immutable=1"):
        try:
            con = sqlite3.connect(uri, uri=True)
            con.execute("SELECT 1")
            return con
        except sqlite3.OperationalError:
            continue
    return sqlite3.connect(p)


def check_node() -> str:
    node = node_bin()
    if not node:
        raise SystemExit(fail("未找到 node，请先安装 Node.js ≥ 22.5"))
    ver = node_version()
    if ver and ver[:2] < MIN_NODE:
        raise SystemExit(fail(f"Node {'.'.join(map(str, ver))} 过旧，需要 ≥ {'.'.join(map(str, MIN_NODE))}（node:sqlite）"))
    return node


# ---------- 生命周期 ----------

def cmd_start(args) -> int:
    node = check_node()
    port = get_port(args)
    if health(port):
        info(f"服务已在运行: http://localhost:{port}")
        return 0
    if pids_on_port(port):
        return fail(f"端口 {port} 被其他进程占用，先执行 python ops.py stop 或换端口")
    LOG_DIR.mkdir(exist_ok=True)
    DATA_DIR.mkdir(exist_ok=True)
    with open(LOG_FILE, "ab") as log:
        log.write(f"\n===== start {datetime.now().isoformat(timespec='seconds')} port={port} =====\n".encode())
        proc = subprocess.Popen([node, str(ROOT / "server.js")], cwd=ROOT,
                                env={**os.environ, "PORT": str(port)},
                                stdout=log, stderr=log, start_new_session=True)
    PID_FILE.write_text(str(proc.pid))
    if not wait_health(port):
        return fail("启动失败（健康检查超时），查看日志: python ops.py logs")
    info(f"服务已启动: http://localhost:{port}  (pid {proc.pid}, 日志 {LOG_FILE.relative_to(ROOT)})")
    return 0


def cmd_stop(args) -> int:
    pid = read_pid()
    port = get_port(args)
    targets = set(pids_on_port(port))
    if pid:
        targets.add(pid)
    if not targets:
        info("服务未在运行")
        return 0
    stopped = []
    for p in targets:
        try:
            os.kill(p, signal.SIGTERM)
            stopped.append(p)
        except ProcessLookupError:
            pass
    deadline = time.time() + 8
    while time.time() < deadline and any(alive(p) for p in stopped):
        time.sleep(0.3)
    for p in stopped:
        if alive(p):
            info(f"pid {p} 未响应 SIGTERM，发送 SIGKILL")
            try:
                os.kill(p, signal.SIGKILL)
            except ProcessLookupError:
                pass
    PID_FILE.unlink(missing_ok=True)
    info(f"已停止: {', '.join(map(str, stopped)) or '（进程已不存在）'}")
    return 0


def cmd_restart(args) -> int:
    cmd_stop(args)
    return cmd_start(args)


def cmd_status(args) -> int:
    port = get_port(args)
    pid = read_pid()
    listeners = pids_on_port(port)
    ok = health(port)
    info(f"端口: {port}   PID 文件: {pid or '—'}   监听进程: {listeners or '—'}")
    info(f"健康检查: {'OK' if ok else '不可达'}   URL: http://localhost:{port}")
    if LAUNCHD_PLIST.exists():
        info(f"launchd 部署: 已安装 ({LAUNCHD_PLIST})")
    if DB_FILE.exists():
        size = DB_FILE.stat().st_size / 1024
        con = open_db_ro(DB_FILE)
        try:
            regions = con.execute("SELECT COUNT(*) FROM regions").fetchone()[0]
            users = con.execute("SELECT COUNT(*) FROM users").fetchone()[0]
            plans = con.execute("SELECT COUNT(*) FROM plans").fetchone()[0]
            last = con.execute(
                "SELECT finished_at || ' ' || status FROM sync_log ORDER BY id DESC LIMIT 1").fetchone()
        finally:
            con.close()
        info(f"数据库: {DB_FILE.relative_to(ROOT)} ({size:.0f} KB) — 地区 {regions}，用户 {users}，方案 {plans}")
        info(f"最近同步: {last[0] if last else '—'}")
    else:
        info("数据库: 尚未初始化（python ops.py init）")
    return 0 if ok else 1


def cmd_dev(args) -> int:
    node = check_node()
    port = get_port(args)
    if pids_on_port(port):
        return fail(f"端口 {port} 已被占用，先 python ops.py stop")
    info(f"开发模式（--watch 热重载）: http://localhost:{port}  Ctrl-C 退出")
    try:
        return subprocess.run([node, "--watch", str(ROOT / "server.js")], cwd=ROOT,
                              env={**os.environ, "PORT": str(port)}).returncode
    except KeyboardInterrupt:
        return 0


def cmd_logs(args) -> int:
    if not LOG_FILE.exists():
        return fail("暂无日志")
    if args.follow:
        try:
            return subprocess.run(["tail", "-n", str(args.lines), "-f", str(LOG_FILE)]).returncode
        except KeyboardInterrupt:
            return 0
    return subprocess.run(["tail", "-n", str(args.lines), str(LOG_FILE)]).returncode


# ---------- 初始化 / 部署 ----------

def cmd_init(_args) -> int:
    check_node()
    if (ROOT / ".gitmodules").exists():
        subprocess.run(["git", "submodule", "update", "--init", "--recursive"], cwd=ROOT)
    DATA_DIR.mkdir(exist_ok=True)
    LOG_DIR.mkdir(exist_ok=True)
    result = run_db_sync()
    info(f"建库并同步基础数据: {json.dumps(result, ensure_ascii=False)}")
    info("初始化完成。启动: python ops.py start")
    return 0


def run_db_sync() -> dict:
    """直连 SQLite 的同步（不要求服务在跑）。"""
    node = check_node()
    script = "const r = require('./db').syncBaseData(); console.log(JSON.stringify(r));"
    out = subprocess.run([node, "-e", script], cwd=ROOT, capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit(fail(f"同步失败: {out.stderr.strip()}"))
    return json.loads(out.stdout.strip().splitlines()[-1])


def cmd_deploy(args) -> int:
    if sys.platform != "darwin":
        return fail("deploy 目前仅支持 macOS launchd；其他平台请自行用 systemd 等托管 node server.js")
    node = check_node()
    port = get_port(args)
    cfg = load_config()
    cfg["port"] = port
    save_config(cfg)
    LOG_DIR.mkdir(exist_ok=True)
    LAUNCHD_PLIST.parent.mkdir(parents=True, exist_ok=True)
    plist = {
        "Label": LAUNCHD_LABEL,
        "ProgramArguments": [node, str(ROOT / "server.js")],
        "WorkingDirectory": str(ROOT),
        "EnvironmentVariables": {"PORT": str(port)},
        "RunAtLoad": True,
        "KeepAlive": True,
        "StandardOutPath": str(LOG_FILE),
        "StandardErrorPath": str(LOG_FILE),
    }
    cmd_stop(args)  # 避免与手动启动的实例端口冲突
    subprocess.run(["launchctl", "unload", str(LAUNCHD_PLIST)], capture_output=True)
    with open(LAUNCHD_PLIST, "wb") as f:
        plistlib.dump(plist, f)
    r = subprocess.run(["launchctl", "load", str(LAUNCHD_PLIST)], capture_output=True, text=True)
    if r.returncode != 0:
        return fail(f"launchctl load 失败: {r.stderr.strip()}")
    if not wait_health(port):
        return fail("部署后健康检查超时，查看日志: python ops.py logs")
    info(f"已部署为 launchd 常驻服务（开机自启、崩溃自动拉起）: http://localhost:{port}")
    info(f"plist: {LAUNCHD_PLIST}")
    return 0


def cmd_undeploy(_args) -> int:
    if not LAUNCHD_PLIST.exists():
        info("未安装 launchd 服务")
        return 0
    subprocess.run(["launchctl", "unload", str(LAUNCHD_PLIST)], capture_output=True)
    LAUNCHD_PLIST.unlink(missing_ok=True)
    info("已卸载 launchd 服务（数据保留）")
    return 0


# ---------- 数据与调整 ----------

def cmd_sync(args) -> int:
    port = get_port(args)
    if health(port):
        body = {"url": args.url} if args.url else {}
        result = http_json("POST", f"http://127.0.0.1:{port}/api/sync", body, timeout=30)
        info(f"经运行中服务同步: {json.dumps(result, ensure_ascii=False)}")
    else:
        if args.url:
            return fail("远程 URL 同步需要服务在运行（python ops.py start）")
        result = run_db_sync()
        info(f"直连 SQLite 同步: {json.dumps(result, ensure_ascii=False)}")
    return 0


def cmd_param(args) -> int:
    port = get_port(args)
    if not health(port):
        return fail("参数操作需要服务在运行（python ops.py start）")
    base = f"http://127.0.0.1:{port}"
    user = args.user or 0
    if args.action == "get":
        print(json.dumps(http_json("GET", f"{base}/api/params?user={user}"), ensure_ascii=False, indent=2))
        return 0
    if args.action == "set":
        try:
            value = json.loads(args.value)
        except json.JSONDecodeError as e:
            return fail(f"value 不是有效 JSON: {e}")
        http_json("PUT", f"{base}/api/params", {"user_id": user, "key": args.key, "value": value})
        info(f"已设置 user={user} {args.key} = {args.value}")
        return 0
    http_json("POST", f"{base}/api/params/reset", {"user_id": user})
    info(f"已重置 user={user} 的参数")
    return 0


def cmd_config(args) -> int:
    cfg = load_config()
    if args.action == "get":
        print(json.dumps(cfg or {"port": DEFAULT_PORT}, ensure_ascii=False, indent=2))
        return 0
    if args.key is None or args.value is None:
        return fail("用法: config set <key> <value>")
    try:
        cfg[args.key] = json.loads(args.value)
    except json.JSONDecodeError:
        cfg[args.key] = args.value
    save_config(cfg)
    info(f"已写入 {CONFIG_FILE.name}: {args.key} = {cfg[args.key]}")
    return 0


def cmd_backup(_args) -> int:
    if not DB_FILE.exists():
        return fail("数据库不存在，无可备份")
    BACKUP_DIR.mkdir(exist_ok=True)
    dest = BACKUP_DIR / f"taxmgr-{datetime.now().strftime('%Y%m%d-%H%M%S')}.db"
    src = sqlite3.connect(DB_FILE)
    dst = sqlite3.connect(dest)
    try:
        src.backup(dst)  # sqlite 在线备份 API，WAL 模式下亦安全
    finally:
        dst.close()
        src.close()
    info(f"备份完成: {dest.relative_to(ROOT)} ({dest.stat().st_size / 1024:.0f} KB)")
    return 0


def cmd_restore(args) -> int:
    src = Path(args.file)
    if not src.exists():
        return fail(f"备份文件不存在: {src}")
    check = open_db_ro(src)
    try:
        okrow = check.execute("PRAGMA integrity_check").fetchone()
    finally:
        check.close()
    if okrow[0] != "ok":
        return fail(f"备份文件完整性检查失败: {okrow[0]}")
    was_running = health(get_port(args))
    cmd_stop(args)
    for suffix in ("", "-wal", "-shm"):
        Path(str(DB_FILE) + suffix).unlink(missing_ok=True)
    shutil.copy2(src, DB_FILE)
    info(f"已从 {src} 恢复数据库")
    if was_running:
        return cmd_start(args)
    return 0


# ---------- 质量 ----------

def cmd_test(_args) -> int:
    node = check_node()
    return subprocess.run([node, str(ROOT / "tests" / "regression.js")], cwd=ROOT).returncode


def cmd_doctor(args) -> int:
    issues = 0
    ver = node_version()
    if ver is None:
        info("✘ node 未安装")
        issues += 1
    else:
        okv = ver[:2] >= MIN_NODE
        info(f"{'✔' if okv else '✘'} node v{'.'.join(map(str, ver))}（需要 ≥ 22.5）")
        issues += 0 if okv else 1
    port = get_port(args)
    listeners = pids_on_port(port)
    ok = health(port)
    info(f"{'✔' if ok or not listeners else '✘'} 端口 {port}: "
         + ("服务健康" if ok else ("空闲" if not listeners else f"被占用 {listeners} 且健康检查失败")))
    issues += 0 if (ok or not listeners) else 1
    if DB_FILE.exists():
        con = open_db_ro(DB_FILE)
        try:
            res = con.execute("PRAGMA integrity_check").fetchone()[0]
        finally:
            con.close()
        info(f"{'✔' if res == 'ok' else '✘'} SQLite 完整性: {res}")
        issues += 0 if res == "ok" else 1
    else:
        info("• 数据库尚未初始化（python ops.py init）")
    if (ROOT / ".gitmodules").exists():
        sub = ROOT / "vendor" / "project-iron-core"
        populated = sub.is_dir() and any(sub.iterdir())
        info(f"{'✔' if populated else '✘'} submodule vendor/project-iron-core {'已就绪' if populated else '未初始化（python ops.py init）'}")
        issues += 0 if populated else 1
    ds = ROOT / "data" / "base-data.json"
    try:
        v = json.loads(ds.read_text(encoding="utf-8"))["version"]
        info(f"✔ 基础数据集 {ds.relative_to(ROOT)} v{v}")
    except Exception as e:
        info(f"✘ 基础数据集异常: {e}")
        issues += 1
    info("体检通过 ✔" if issues == 0 else f"发现 {issues} 项问题 ✘")
    return 0 if issues == 0 else 1


# ---------- 卸载 ----------

def cmd_uninstall(args) -> int:
    if args.purge and not args.yes:
        answer = input("[ops] --purge 将删除数据库与全部备份，确认？(yes/N) ").strip().lower()
        if answer not in ("y", "yes"):
            info("已取消")
            return 0
    cmd_undeploy(args)
    cmd_stop(args)
    removed = []
    for p in [PID_FILE, CONFIG_FILE]:
        if p.exists():
            p.unlink()
            removed.append(p.name)
    if LOG_DIR.exists():
        shutil.rmtree(LOG_DIR)
        removed.append("logs/")
    if args.purge:
        for suffix in ("", "-wal", "-shm"):
            Path(str(DB_FILE) + suffix).unlink(missing_ok=True)
        if BACKUP_DIR.exists():
            shutil.rmtree(BACKUP_DIR)
        removed += ["data/taxmgr.db", "backups/"]
    info(f"卸载完成，已清理: {', '.join(removed) or '（无运行文件）'}")
    if not args.purge:
        info("数据库与备份已保留；彻底清除请加 --purge")
    return 0


# ---------- 入口 ----------

def main() -> int:
    parser = argparse.ArgumentParser(
        prog="ops.py", description="proprietor-tax-manager 统一运维入口",
        formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    sub = parser.add_subparsers(dest="cmd")

    def add(name, fn):
        p = sub.add_parser(name)
        p.set_defaults(fn=fn)
        return p

    for name, fn in [("start", cmd_start), ("restart", cmd_restart), ("dev", cmd_dev),
                     ("deploy", cmd_deploy)]:
        add(name, fn).add_argument("--port", type=int)
    for name, fn in [("stop", cmd_stop), ("status", cmd_status), ("undeploy", cmd_undeploy),
                     ("init", cmd_init), ("backup", cmd_backup), ("test", cmd_test),
                     ("doctor", cmd_doctor)]:
        add(name, fn)
    p = add("logs", cmd_logs)
    p.add_argument("-n", "--lines", type=int, default=60)
    p.add_argument("-f", "--follow", action="store_true")
    p = add("sync", cmd_sync)
    p.add_argument("--url", help="远程 https 数据源 JSON")
    p = add("param", cmd_param)
    p.add_argument("action", choices=["get", "set", "reset"])
    p.add_argument("key", nargs="?")
    p.add_argument("value", nargs="?")
    p.add_argument("--user", type=int, default=0)
    p = add("config", cmd_config)
    p.add_argument("action", choices=["get", "set"])
    p.add_argument("key", nargs="?")
    p.add_argument("value", nargs="?")
    p = add("restore", cmd_restore)
    p.add_argument("file")
    p = add("uninstall", cmd_uninstall)
    p.add_argument("--purge", action="store_true", help="连数据库与备份一并删除")
    p.add_argument("--yes", action="store_true", help="跳过确认")

    args = parser.parse_args()
    if not args.cmd:
        args = parser.parse_args(["restart"])  # iron-rules 默认入口
    if args.cmd == "param" and args.action == "set" and (not args.key or args.value is None):
        return fail("用法: param set <key> <json> [--user N]")
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())

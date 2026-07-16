#!/usr/bin/env python3
"""
Archive one LLM conversation output into:
LLM_OUTPUTS/YYYY/MM/DD/HHmmss-topic.md
"""

from __future__ import annotations

import argparse
import re
from datetime import datetime
from pathlib import Path


def slugify(topic: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9\\u4e00-\\u9fff_-]+", "-", topic.strip())
    normalized = re.sub(r"-{2,}", "-", normalized).strip("-_")
    return normalized[:80] or "chat-output"


def build_output_path(project_root: Path, topic: str, ts: datetime) -> Path:
    out_dir = project_root / "LLM_OUTPUTS" / ts.strftime("%Y") / ts.strftime("%m") / ts.strftime("%d")
    out_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{ts.strftime('%H%M%S')}-{slugify(topic)}.md"
    return out_dir / filename


def read_text(args: argparse.Namespace) -> str:
    if args.stdin:
        import sys
        return sys.stdin.read()
    if args.source_file:
        return Path(args.source_file).read_text(encoding="utf-8")
    return args.content or ""


def render_markdown(*, topic: str, source: str, model: str, text: str, ts: datetime) -> str:
    return (
        f"# {topic}\\n\\n"
        f"- source: {source}\\n"
        f"- model: {model}\\n"
        f"- archived_at: {ts.isoformat(timespec='seconds')}\\n\\n"
        "## Output\\n\\n"
        f"{text.strip()}\\n"
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Archive LLM output to LLM_OUTPUTS date folders.")
    parser.add_argument("--project-root", default=".", help="Project root path (default: current directory).")
    parser.add_argument("--topic", required=True, help="Topic for filename and title.")
    parser.add_argument("--source", default="cursor", choices=["codex", "cursor", "claude-code", "vscode", "manual"])
    parser.add_argument("--model", default="unknown", help="Model label.")
    parser.add_argument("--source-file", help="Read output content from a text/markdown file.")
    parser.add_argument("--content", help="Inline output content.")
    parser.add_argument("--stdin", action="store_true", help="Read output content from stdin.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    text = read_text(args)
    if not text.strip():
        print("ERROR: empty output content. Use --source-file, --content, or --stdin.")
        return 2

    project_root = Path(args.project_root).resolve()
    ts = datetime.now()
    output_path = build_output_path(project_root, args.topic, ts)
    markdown = render_markdown(topic=args.topic, source=args.source, model=args.model, text=text, ts=ts)
    output_path.write_text(markdown, encoding="utf-8")
    print(str(output_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

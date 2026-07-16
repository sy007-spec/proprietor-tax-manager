# Codex Project Rules Adapter

## Mandatory Rules
- Archive every raw prompt to `PROMPT_INPUT_LOG.md`.
- On each intake, sync `AGENTS.md`, `CLAUDE.md`, Cursor rules, and VSCode rules.
- Keep unified ops entrypoint: `python ops.py restart`.
- Archive every LLM conversation output to `LLM_OUTPUTS/YYYY/MM/DD/*.md`.
- Load project requirements from `PROJECT_LLM_REQUIREMENTS.json` and enforce them in every session.
- For substantive build or behavior change, author or update a **requirements spec** in-repo first; implement against it; feed back into the spec.

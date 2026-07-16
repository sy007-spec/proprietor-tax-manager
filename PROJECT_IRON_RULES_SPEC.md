# Project Iron Rules Spec (v1.7)

## Core Rules
- Append every raw user prompt to `PROMPT_INPUT_LOG.md` (append-only).
- On every new intake, check and sync rules in:
  - `AGENTS.md`
  - `CLAUDE.md`
  - `.cursor/rules/project-iron-rules.mdc`
  - `.vscode/RULES.md`
- Keep all ops under one command: `python ops.py restart`.
- Archive every LLM conversation output (Codex/Cursor/claude-code/VSCode) to:
  - `LLM_OUTPUTS/YYYY/MM/DD/*.md`
- Treat the project as an npx skill orchestration system.
- **Rule 9 (requirements spec):** Maintain a **complete, version-controlled requirements spec** for the code system *before* substantive build: spec first, implement against the spec, then update the spec from delivery feedback. Complements `PROJECT_LLM_REQUIREMENTS.json`.

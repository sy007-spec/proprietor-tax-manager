# VSCode Rules Adapter

## Mandatory
- Archive prompts into `PROMPT_INPUT_LOG.md`.
- Sync rules across AGENTS/Codex, Claude, Cursor, and VSCode on every intake.
- Use unified ops command: `python ops.py restart`.
- Archive each conversation output to `LLM_OUTPUTS/YYYY/MM/DD/*.md`.
- Keep npx skill orchestration as baseline.
- Load and enforce `PROJECT_LLM_REQUIREMENTS.json` as project metadata.
- **Requirements spec first** (Rule 9): spec -> build -> feed back to spec.

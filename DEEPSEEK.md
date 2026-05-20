# DeepSeek CLI — an agentic coding CLI for DeepSeek models, inspired by Claude Code

## Tech stack
- **Language**: TypeScript (strict mode, ES2022 target, NodeNext ESM modules)
- **Runtime**: Node.js >= 18
- **API**: DeepSeek API via OpenAI SDK (openai ^4.77)
- **Key deps**: commander, chalk, @inquirer/prompts, diff, glob
- **Dev tools**: tsx (run TS directly), tsc (build), no formatter/linter configured

## Project structure

| Path | Role |
|------|------|
| `src/index.ts` | CLI entry point — commander setup, config loading, permission system, REPL or one-shot dispatch |
| `src/agent.ts` | Core agent loop — system prompt, streaming responses, tool-call iteration (max 25), context auto-compression, file mention expansion (`@path`), git context injection |
| `src/client.ts` | DeepSeek API client wrapping `openai` SDK — streaming chat completions, reasoning-content handling, model listing |
| `src/config.ts` | Config management — `~/.deepseek-cli/config.json`, env overrides (`DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL`, `DEEPSEEK_THINKING`), model definitions, thinking-mode normalization |
| `src/commands.ts` | Slash-command handlers — `/help`, `/model`, `/init`, `/review`, `/doctor`, `/compress`, `/task`, `/thinking`, `/todos`, `/tools`, `/config`, `/hooks`, `/mcp`, `/skills`, `/skill-new`, `/plugin`, `/memory`, `/clear`, `/save`, `/resume`, `/usage`, `/exit` |
| `src/session.ts` | Per-project session persistence — SHA256-hashed JSON in `~/.deepseek-cli/sessions/` |
| `src/project.ts` | Project root detection (by markers: `.git`, `package.json`, etc.), project instruction loading (`DEEPSEEK.md`/`CLAUDE.md`/`AGENTS.md`), `# note` memory appending |
| `src/skills.ts` | Custom skill commands — Markdown files with YAML frontmatter in `.deepseek/skills/` (project) or `~/.deepseek-cli/skills/` (global); supports `{{input}}`, `{{args}}`, `{{cwd}}` placeholders |
| `src/plugins.ts` | Plugin system — install from marketplace/git/local, scaffold new plugins, enable/disable/remove |
| `src/mcp.ts` | MCP (Model Context Protocol) stdio server integration — start/stop servers, tool discovery, JSON-RPC communication |
| `src/hooks.ts` | preToolUse/postToolUse shell hooks — config in `.deepseek/hooks.json`, blocking support on preToolUse failure |
| `src/todo.ts` | Todo store — `pending | in_progress | completed` states, exactly one in_progress enforced |
| `src/permissions.ts` | Tool permission manager — per-call approve/deny, session-level always-allow, `--yes` auto-approve |
| `src/ui/render.ts` | Terminal rendering — colored output, spinner, usage/cost display, diff coloring |
| `src/ui/repl.ts` | Interactive REPL — multiline input (trailing `\`), tab completion, command suggestions, history, shell escape (`! command`), `# note` memory |
| `src/tools/` | Built-in tools: `read_file`, `write_file`, `edit_file`, `bash`, `search_text` (grep), `list_files` (glob), `web_search`, `web_fetch`, `set_thinking`, `todo_read`, `todo_write` |
| `dist/` | Compiled JS output (gitignored) |
| `tsconfig.json` | TypeScript config — strict, NodeNext, rootDir `src`, outDir `dist` |

## Commands

All verified from `package.json` scripts:

```bash
# Run in development (no build needed, tsx compiles on-the-fly)
npm run dev

# Run with a prompt
npm run dev -- "summarize this project"

# Type-check only (no emit)
npm run typecheck

# Build JavaScript to dist/
npm run build

# Run the built output
npm start
```

After building, the CLI registers the `deepseek` binary (`dist/index.js`).

Environment variables:
- `DEEPSEEK_API_KEY` — API key (required)
- `DEEPSEEK_BASE_URL` — override API base URL (default: `https://api.deepseek.com`)
- `DEEPSEEK_MODEL` — default model
- `DEEPSEEK_THINKING` — thinking display: `off | collapsed | full`

CLI options (from commander in `src/index.ts`):
- `-m, --model` — choose model
- `-p, --print` — one-shot print mode
- `-y, --yes` — auto-approve all tools
- `--api-key` — key override
- `--thinking` — reasoning display mode
- `--continue / --resume` — restore saved session

## Conventions & notes

- **ESM only**: `"type": "module"` in package.json; all imports use `.js` extensions.
- **No test/lint commands exist** in the project — no jest, vitest, eslint, or prettier config.
- **Reasoning content lifecycle**: DeepSeek requires `reasoning_content` to accompany `tool_calls` during an active tool chain, but it must be stripped from messages between user turns (`stripReasoningContent()`). Not doing so causes HTTP 400.
- **Context auto-compress**: triggers at ~48K estimated tokens or ~80 messages; uses the same DeepSeek model to generate a continuity summary, then resets message history while keeping the system prompt.
- **Session path**: keyed by SHA256 hash of the absolute working directory — changing the cwd means a different session.
- **Project root**: walks up from cwd looking for `.git`, `package.json`, `pyproject.toml`, etc. Memory files (`DEEPSEEK.md`, `CLAUDE.md`, `AGENTS.md`) are loaded from the root down to cwd (subdirectory memory overrides but does not replace).
- **Tool approval**: write/bash/edit/search tools require approval; read-only tools (read_file, list_files, search_text, web_search, web_fetch) skip approval. `--yes` skips all.
- **Max tool iterations**: 25 per user turn; the agent stops with a warning if exceeded.
- **File mentions**: `@path/to/file` in user input expands to inline file content (max 50K chars per file).
- **Shell escape**: `! command` runs a shell command directly without going through the agent.
- **Memory notes**: `# note text` appends a bullet to `## Notes` in `DEEPSEEK.md` and reloads project context.
- **Config persistence**: `~/.deepseek-cli/config.json` — API keys from env vars are never persisted to disk.

---

Captured: TypeScript ESM project — DeepSeek CLI agent with REPL, tool loop, slash commands, MCP, hooks, plugins, session persistence, and project memory. No test/lint infra.

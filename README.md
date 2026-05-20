# DeepSeek CLI

An agentic coding CLI for DeepSeek models, inspired by the Claude Code workflow.

## Current Capabilities

- Interactive REPL and one-shot prompt mode.
- DeepSeek-compatible OpenAI SDK client with streaming responses.
- Tool calling loop for reading/editing files, writing files, running shell commands, grep/glob search, and basic web fetch/search.
- Approval prompts for side-effecting tools, with a dangerous `--yes` mode for trusted sessions.
- Slash commands for help, model selection, tool listing, config display, context compression, conversation reset, and project memory.
- Project instruction loading from `DEEPSEEK.md`, `CLAUDE.md`, and `AGENTS.md`.

## Install and Run

```bash
npm install
npm run build
npm run dev -- "summarize this project"
```

Set your API key with either:

```bash
export DEEPSEEK_API_KEY="your-key"
```

or run the CLI interactively and enter the key when prompted.

## Commands

- `/help`: show available slash commands.
- `/init`: create a `DEEPSEEK.md` project instruction file in the detected project root.
- `/memory`: show which project instruction files are loaded.
- `/model`: fetch available models from the DeepSeek API and choose with arrow keys.
- `/models`: fetch and list available DeepSeek models.
- `/skills`: list custom skill commands.
- `/skill-new <name>`: create a project skill template.
- `/compress`: summarize the current conversation into durable context and save it with the project session.
- `/tools`: list available tools.
- `/config`: show active config.
- `/clear`: reset the conversation.
- `/exit`: quit.

Press Tab after `/` to complete commands. Typing `/` by itself lists commands. Long sessions are auto-compressed before the next request when they exceed the built-in context threshold.

## Custom Skills

Project skills live in `.deepseek/skills/*.md`. Global skills live in `~/.deepseek-cli/skills/*.md`.

Create one with:

```bash
deepseek
/skill-new work-report
```

Then edit `.deepseek/skills/work-report.md`. The file becomes a slash command named `/work-report` automatically. Use `{{input}}`, `{{args}}`, or `{{cwd}}` inside the skill prompt to receive command arguments and project context.

Example skill:

```markdown
---
name: work-report
description: Generate a daily work report
---

Read the current repository changes and generate a concise daily report.

Extra user input:
{{input}}
```

## Models

- `deepseek-v4-pro`: flagship V4 model for complex coding, reasoning, and agentic work.
- `deepseek-v4-flash`: fast and cost-efficient V4 model for everyday coding tasks.

## Roadmap Toward a Claude Code-like CLI

- Stronger project memory: user/global memory, import support, and scoped overrides.
- Better editing tools: multi-edit, diff previews, and safer patch application.
- Task planning: explicit todo tracking tool and progress rendering.
- Session continuity: save and resume conversations per project.
- Permission management: persisted allow/deny rules and command risk checks.
- Project intelligence: indexing, symbol search, diagnostics, and test discovery.
- UX polish: multiline input, shell mode, status/cost display, and richer terminal output.

## Development

```bash
npm run typecheck
npm run build
```
# deepseek-cli

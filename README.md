# DeepSeek CLI

An agentic coding CLI for DeepSeek models, inspired by the Claude Code workflow.

## Current Capabilities

- Interactive REPL and one-shot prompt mode.
- DeepSeek-compatible OpenAI SDK client with streaming responses.
- Tool calling loop for reading/editing files, writing files, running shell commands, grep/glob search, todo tracking, and basic web fetch/search.
- Approval prompts for side-effecting tools, with a dangerous `--yes` mode for trusted sessions.
- Slash commands for help, model selection, tool/todo listing, config display, review/doctor, context compression, conversation reset, and project memory.
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
- `/review [ref]`: review local git changes or compare against a ref.
- `/task <prompt>`: run an isolated subagent-style task without polluting main history.
- `/hooks [init|list]`: configure preToolUse/postToolUse shell hooks.
- `/mcp [list|init|reload]`: configure and load MCP stdio servers as tools.
- `/doctor`: check local environment/configuration health.
- `/thinking [on|off|collapsed|full]`: control reasoning trace display.
- `/todos`: show the current TodoWrite task list.
- `/tools`: list available tools.
- `/config`: show active config.
- `/clear`: reset the conversation.
- `/exit`: quit.

Press Tab after `/` to complete commands. Typing `/` by itself lists commands. Use `@path/to/file` in prompts to attach file contents, `# note` to append project memory, `! command` to run shell directly, and Esc/Ctrl-C to interrupt generation. Long sessions are auto-compressed before the next request when they exceed the built-in context threshold. Use `--continue` or `--resume` with one-shot prompts to restore the saved project session.

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

## MCP Servers

DeepSeek CLI can load external MCP stdio servers and expose their tools to the model.

```bash
deepseek
/mcp init
# edit .deepseek/mcp.json
/mcp reload
/mcp
```

Project config lives at `.deepseek/mcp.json`; global config lives at `~/.deepseek-cli/mcp.json`. The loader also reads Claude-compatible `.mcp.json` files that use the `mcpServers` key.

Example:

```json
{
  "servers": {
    "filesystem": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server.js"]
    }
  }
}
```

Loaded MCP tools are registered as `mcp__server__tool` and still go through the normal permission confirmation flow before execution.

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
- UX polish: multiline input, shell mode, status/cost display, interruptible generation, and richer terminal output.

## Development

```bash
npm run typecheck
npm run build
```

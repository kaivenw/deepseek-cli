# DeepSeek CLI

基于 DeepSeek 模型的智能体编程命令行工具，提供类似 Claude Code 的交互体验——直接在终端里让 AI 阅读你的代码库、编辑文件、执行命令、联网搜索。内置工具调用、权限确认、项目记忆、会话管理、上下文压缩、**检查点回溯**、**子代理**、**MCP 服务器**、**工具钩子**与**插件系统**。

## 目录

- [快速开始](#快速开始)
- [核心概念](#核心概念)
  - [智能体循环](#智能体循环)
  - [工作模式](#工作模式)
  - [项目记忆](#项目记忆)
  - [输入与交互快捷方式](#输入与交互快捷方式)
  - [会话管理](#会话管理)
  - [检查点与回溯](#检查点与回溯)
  - [上下文压缩](#上下文压缩)
- [内置工具](#内置工具)
- [斜杠命令](#斜杠命令)
- [扩展能力](#扩展能力)
  - [自定义技能](#自定义技能)
  - [子代理](#子代理)
  - [MCP 服务器](#mcp-服务器)
  - [工具钩子](#工具钩子)
  - [插件系统](#插件系统)
- [配置](#配置)
  - [配置文件](#配置文件)
  - [环境变量](#环境变量)
  - [联网搜索](#联网搜索)
  - [图片与多模态](#图片与多模态)
  - [CLI 参数](#cli-参数)
  - [支持的模型](#支持的模型)
- [开发](#开发)

## 快速开始

### 前置要求

- **Node.js** >= 18
- **DeepSeek API Key**（在 [platform.deepseek.com](https://platform.deepseek.com/api_keys) 获取）

### 安装与启动

```bash
# 克隆并安装依赖
git clone <repo-url> deepseek-cli
cd deepseek-cli
npm install

# 编译 TypeScript
npm run build

# 设置 API 密钥
export DEEPSEEK_API_KEY="sk-xxxxxxxxxxxxxxxx"

# 启动交互式 REPL
npm start
# 或者开发模式直跑
npm run dev
```

首次启动时若未设置环境变量，CLI 会提示你输入 API 密钥并可选保存到配置文件。
编译后 `dist/index.js` 注册为 `deepseek` 命令（package.json 的 `bin` 字段），可 `npm link` 后全局使用。

### 第一个任务

```bash
# 单次提问模式（问完即退出）
deepseek "总结一下这个项目的功能和结构"

# 交互模式
deepseek
▸ 帮我看看 src/index.ts 的入口逻辑
▸ 写一个对 agent.ts 的单元测试
```

## 核心概念

### 智能体循环

DeepSeek CLI 运行一个**智能体循环（Agent Loop）**：

1. **接收**你的自然语言指令
2. **理解**——自动读取项目指令文件（`DEEPSEEK.md`）、Git 状态、上次会话摘要
3. **规划**——需要多步骤时自动创建待办列表（`todo_write`）
4. **执行**——调用内置工具读取文件、搜索代码、运行命令、编辑文件
5. **验证**——每步操作都有结果反馈，出错会自行修复
6. **循环**——反复执行直到完成任务（最多 25 轮工具调用）

核心循环位于 `src/agent.ts`，包含流式响应、推理内容管理、权限控制、Hook 触发、检查点快照与自动压缩。生成过程中按 **Esc** 或 **Ctrl-C** 可随时中断当前回合。

### 工作模式

| 模式 | 用法 | 说明 |
|------|------|------|
| **交互 REPL** | `deepseek` | 多轮对话，支持多行输入（行末 `\` 续行） |
| **单次提问** | `deepseek "任务描述"` | 执行一次后打印结果退出 |
| **管道输入** | `echo "log内容" \| deepseek` | 标准输入作为提示词 |
| **恢复会话** | `deepseek --continue` | 恢复上次保存的项目会话后再执行 |
| **自动审批** | `deepseek --yes "修复lint错误"` | 跳过所有权限确认（谨慎使用） |

### 项目记忆

CLI 启动时会自动从项目目录加载指令文件，优先级从根到当前目录：

- `DEEPSEEK.md` —— 项目专属指令文件
- `CLAUDE.md` —— 兼容 Claude Code 格式
- `AGENTS.md` —— 兼容其他 Agent CLI

这些内容会注入系统提示词，让模型了解项目的技术栈、目录结构、构建命令与编码规范。

**智能初始化**：运行 `/init`，Agent 会主动勘探项目（列目录、读 `package.json`/README/配置/入口），据此生成一份基于真实内容的 `DEEPSEEK.md`，而非套模板。

### 输入与交互快捷方式

| 快捷方式 | 作用 |
|------|------|
| `@path/to/file.ts` | 在提示词中内联引用文件内容（单文件上限 50,000 字符） |
| **拖拽文件/图片到窗口** | 终端会插入绝对路径，CLI 自动识别为附件，无需 `@` 前缀（支持空格转义/引号路径、混合文本、多文件） |
| `# 这个项目用 PostgreSQL` | 一句话写入项目记忆，自动追加到 `DEEPSEEK.md` 的 `## Notes` |
| `! ls -la` | 直接执行 Shell 命令，不经过 Agent |
| **Option/Alt+Enter** | 插入换行（多行输入，不提交）；也可行末 `\` 续行 |
| **Ctrl+R** | 反向增量搜索输入历史 |
| **Ctrl+A/E · Ctrl+U/K · Ctrl+W · Alt+←→** | 行首尾 / 删到首尾 / 删词 / 按词移动 |
| **Ctrl+L** | 清屏（保留输入） |
| **Esc / Ctrl-C** | 中断正在进行的生成 |

输入历史按项目持久化（重启后 ↑ 可调出），多行粘贴保留换行。文件编辑（`write_file`/`edit_file`）会以**彩色 diff** 展示具体改动。

### 会话管理

每个项目的会话自动保存到 `~/.deepseek-cli/sessions/<hash>.json`（以项目绝对路径的 SHA256 哈希为键），进入 REPL 时自动恢复。

```bash
# 交互模式中
/save              # 手动保存当前会话
/resume            # 恢复上次保存的会话
/clear             # 清除对话历史及持久会话

# CLI 参数
deepseek --continue "继续上次的登录模块开发"
deepseek --resume   # 别名
```

### 检查点与回溯

CLI 在**每个用户回合开始前自动创建检查点**，快照当时的对话；回合内 `write_file`/`edit_file` 修改文件前会记录文件原内容。你可以随时回退：

```bash
/rewind            # 交互式选择回退到哪个检查点
/rewind 2          # 直接回退到第 2 个检查点
/undo              # 回退最近一个回合
```

回退会**同时还原对话历史和文件**——把改过的文件还原到该检查点时的内容，回合内**新建的文件会被删除**，并丢弃该点之后的检查点。

> 说明：检查点为**会话内内存态**（进程退出即失，与 Claude Code 的会话内回溯一致），不写盘以避免会话膨胀；文件 undo 仅覆盖经 `write_file`/`edit_file` 工具的改动，不含 `!shell` 原始命令。

### 上下文压缩

当对话达到约 **48,000 token** 或 **80 条消息**时，系统会自动压缩上下文：

- 将完整对话发送给模型生成**持续性摘要**
- 清空消息历史，把摘要注入下一轮系统提示词
- 也可手动触发：`/compress`

压缩摘要随会话持久化，恢复会话时继续有效。

## 内置工具

| 工具 | 功能 | 需审批 |
|------|------|--------|
| `read_file` | 读取文件内容（支持偏移量和行数限制） | ✗ |
| `write_file` | 创建或覆盖文件（自动建父目录，展示 diff） | ✓ |
| `edit_file` | 精确字符串替换编辑（展示 diff） | ✓ |
| `bash` | 执行 Shell 命令（超时默认 120s，最长 600s） | ✓ |
| `search_text` | 正则搜索文件内容（优先 ripgrep，回退 JS） | ✗ |
| `list_files` | Glob 模式文件列表 | ✗ |
| `web_search` | 联网搜索（博查 / Tavily / DuckDuckGo，见[联网搜索](#联网搜索)） | ✗ |
| `web_fetch` | 抓取网页并转纯文本 | ✗ |
| `set_thinking` | 用对话开关推理显示（off/collapsed/full） | ✗ |
| `todo_read` | 读取当前待办列表 | ✗ |
| `todo_write` | 创建/更新待办列表（同时只有一个 in_progress） | ✗ |
| `task` | 委派一个**隔离子代理**完成子任务并返回结果（见[子代理](#子代理)） | ✗ |

只读工具（`read_file`、`list_files`、`search_text`、`web_search`、`web_fetch`）**无需审批**；有副作用的工具（`write_file`、`edit_file`、`bash`、以及 MCP 工具）**需用户确认**。`--yes` 可跳过所有确认。

## 斜杠命令

在交互模式中输入 `/` 前缀的命令：

| 命令 | 功能 |
|------|------|
| `/help`、`/?` | 显示帮助和命令列表 |
| `/init` | 勘探项目并创建/更新 `DEEPSEEK.md` 指令文件 |
| `/model` | 方向键选择模型（从 API 获取或本地回退） |
| `/models` | 列出可用的 DeepSeek 模型 |
| `/key [add\|use\|rm\|list]` | 切换 / 添加 / 删除 API Key（带有效性校验，切换保留会话） |
| `/thinking [on\|off\|collapsed\|full]` | 控制推理过程显示（裸命令切换 on/off） |
| `/config` | 显示当前配置 |
| `/mcp <list\|init\|reload>` | 管理 MCP 服务器 |
| `/skills` | 列出所有自定义技能 |
| `/skill-new <name>` | 创建项目级技能模板 |
| `/plugin <list\|search\|install\|new\|remove\|enable\|disable\|update>` | 管理插件 |
| `/hooks [init\|list]` | 管理工具执行钩子 |
| `/review [ref]` | 审查 Git 改动（默认 `git diff HEAD`） |
| `/task <prompt>` | 在隔离上下文中跑一个子任务（不污染主对话） |
| `/btw [note\|list\|done <n>\|clear]` | 记录"顺便提一句"的题外待办，不打断当前任务 |
| `/rewind [n]`、`/undo` | 回退对话并撤销文件改动到某个检查点 |
| `/doctor` | 检查环境和配置健康状态 |
| `/compress` | 手动压缩上下文为持续摘要 |
| `/todos`、`/todo` | 显示当前待办任务列表 |
| `/tools` | 列出所有可用工具及审批要求 |
| `/memory` | 显示加载的项目指令文件 |
| `/save`、`/resume` | 保存 / 恢复会话 |
| `/usage` | 显示本次会话的 Token 用量与费用估算 |
| `/clear` | 清除对话历史和已保存会话 |
| `/exit`、`/quit`、`/q`、`exit`、`quit` | 退出（自动保存会话） |

**使用技巧**：
- 输入 `/` 后按 **Tab** 自动补全命令名
- 单独输入 `/` 浏览所有可用命令
- 输入错误命令会自动给出模糊匹配建议

## 扩展能力

### 自定义技能

技能是带 YAML 前置元数据的 Markdown 文件，存放于：

- **项目级**：`.deepseek/skills/*.md`
- **全局级**：`~/.deepseek-cli/skills/*.md`

```bash
deepseek
/skill-new deploy-staging
# 编辑 .deepseek/skills/deploy-staging.md
```

支持 `{{input}}`、`{{args}}`、`{{cwd}}` 占位符：

```markdown
---
name: deploy-staging
description: 部署到预发环境
---

执行以下部署步骤（当前 cwd: {{cwd}}）：
1. 运行 `npm run build`
2. 运行 `npm run deploy:staging`

用户的额外参数：
{{input}}
```

创建后自动注册为 `/deploy-staging` 命令。优先级：全局技能 < 插件技能 < 项目技能（同名覆盖）。

### 子代理

`task` 工具让模型把一个**自包含的子任务**委派给一个独立子代理：

- 子代理拥有**全新上下文**和标准工具（自动排除 `task` 以防递归，深度上限 2）
- 跑完把**最终答复**返回给主代理，不污染主对话
- 可选 `tools` 白名单限定子代理可用工具子集
- 当前为**顺序执行**（单终端下不并行流式输出）

模型会在合适时自动调用；你也可以用 `/task <prompt>` 手动触发一次隔离运行。

### MCP 服务器

Model Context Protocol (MCP) 支持加载外部工具，让模型访问数据库、API、设计稿等。支持两种传输：**stdio**（本地子进程）与 **Streamable HTTP/SSE**（远程服务器）。

```bash
deepseek
/mcp init              # 创建 .deepseek/mcp.json 模板
/mcp reload            # 重新加载 MCP 工具
/mcp list              # 查看加载的工具与配置路径
```

配置文件（项目：`.deepseek/mcp.json` 或 Claude 兼容的 `.mcp.json`；全局：`~/.deepseek-cli/mcp.json`）：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
    },
    "remote-api": {
      "url": "https://example.com/mcp",
      "type": "http",
      "headers": { "Authorization": "Bearer xxx" }
    }
  }
}
```

- 给 `command` 走 stdio；给 `url`（或 `type: "http"/"sse"`）走 HTTP，自动处理 `Mcp-Session-Id` 与 SSE 响应。
- `servers` 与 `mcpServers` 两种键名都支持；`disabled: true` 可临时禁用。
- 加载后的工具以 `mcp__<server>__<tool>` 命名，执行前同样经过权限确认。

### 工具钩子

在生命周期节点自动运行 Shell 脚本（配置于 `.deepseek/hooks.json`）：

```bash
/hooks init           # 创建钩子配置模板
/hooks list           # 查看当前钩子
```

支持事件：

| 事件 | 触发时机 | 可阻断 |
|------|---------|--------|
| `sessionStart` | 会话开始 | ✗ |
| `userPromptSubmit` | 用户提交提示词后、模型处理前 | ✓ |
| `preToolUse` | 工具执行前 | ✓ |
| `postToolUse` | 工具执行后 | ✗ |
| `stop` | 一轮回答结束 | ✗ |

```json
{
  "userPromptSubmit": [
    { "command": "echo prompt: $DEEPSEEK_PROMPT", "continueOnError": true }
  ],
  "preToolUse": [
    { "command": "eslint $DEEPSEEK_TOOL_PREVIEW", "continueOnError": true }
  ],
  "postToolUse": [
    { "command": "echo $DEEPSEEK_TOOL_NAME:$DEEPSEEK_TOOL_STATUS" }
  ]
}
```

注入的环境变量：`DEEPSEEK_HOOK_EVENT`、`DEEPSEEK_TOOL_NAME`、`DEEPSEEK_TOOL_PREVIEW`、`DEEPSEEK_TOOL_STATUS`（`success`/`error`）、`DEEPSEEK_PROMPT`。可阻断事件在钩子失败且未设 `continueOnError: true` 时会拦截后续动作。

### 插件系统

通过 `/plugin` 安装和管理可复用扩展包，插件可打包多个技能：

```bash
/plugin search formatter        # 搜索插件市场
/plugin install <name|git-url|本地路径>   # 安装（按名走市场，或直接给 git/路径）
/plugin new my-code-style       # 一键脚手架生成插件模板
/plugin list                    # 列出已安装插件
/plugin enable|disable <name>   # 启用/禁用（不删除）
/plugin update <name>           # git 来源执行 git pull
/plugin remove <name>           # 卸载
```

- 插件装在 `~/.deepseek-cli/plugins/<name>/`，清单记录于 `~/.deepseek-cli/plugins.json`。
- 插件目录含 `plugin.json` 清单 + `skills/*.md`；启用后其技能自动成为斜杠命令。
- 市场索引通过环境变量 `DEEPSEEK_PLUGIN_REGISTRY` 指向一个 `index.json`（URL 或本地路径）。

## 配置

### 配置文件

配置存储于 `~/.deepseek-cli/config.json`：

```json
{
  "baseURL": "https://api.deepseek.com",
  "model": "deepseek-v4-pro",
  "alwaysAllow": [],
  "thinkingMode": "collapsed",
  "apiKeys": {
    "default": { "key": "sk-xxxx" },
    "团队":    { "key": "sk-yyyy", "baseURL": "https://代理地址" }
  },
  "activeApiKey": "default"
}
```

- `apiKey`：可写入文件，但**从环境变量读取的密钥不会被持久化到磁盘**。
- `apiKeys` / `activeApiKey`：命名 Key 档案与当前选中项,通常用 `/key` 管理而无需手改；旧的单 `apiKey` 会自动迁移为 `default` 档案。
- `thinkingMode`：`off`（隐藏推理）/ `collapsed`（折叠显示前几行）/ `full`（完整显示）。
- `alwaysAllow`：始终免审批的工具名称列表。

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DEEPSEEK_API_KEY` | DeepSeek API 密钥 | 无（必填） |
| `DEEPSEEK_BASE_URL` | API 端点地址 | `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | 默认模型 | `deepseek-v4-pro` |
| `DEEPSEEK_THINKING` | 推理显示模式（off/collapsed/full） | 配置文件设定 |
| `DEEPSEEK_VISION` | 设为 `1` 时把当前模型当作支持视觉（发送图片） | 关闭 |
| `DEEPSEEK_PLUGIN_REGISTRY` | 插件市场索引地址 | 无（可选） |
| `WEB_SEARCH_PROVIDER` | 强制搜索后端（bocha/tavily/duckduckgo） | 自动 |
| `BOCHA_API_KEY` | 博查搜索 API 密钥 | 无 |
| `TAVILY_API_KEY` | Tavily 搜索 API 密钥 | 无 |

环境变量优先级**高于**配置文件。旧版兼容：`DEEPSEEK_SHOW_THINKING` 仍可工作。

### 联网搜索

`web_search` 支持可插拔后端，按以下顺序选择：

1. `WEB_SEARCH_PROVIDER` 显式指定
2. 设置了 `BOCHA_API_KEY` → **博查**（国内网络友好，推荐）
3. 设置了 `TAVILY_API_KEY` → **Tavily**（海外）
4. 都未配置 → **DuckDuckGo**（免 key，但国内常不稳定）

```bash
export BOCHA_API_KEY="sk-你的博查key"   # 推荐
```

### 图片与多模态

拖入图片即会作为附件处理。**当前 DeepSeek 对话 API 为纯文本**：未启用视觉时，图片不会发送，CLI 会给出文本提示而非报错。多模态管线（base64 `image_url`）已就绪——当你使用支持视觉的模型时，在 `ModelInfo.supportsVision` 标记，或设 `DEEPSEEK_VISION=1` 即可直接发送图片。

### CLI 参数

```
deepseek [prompt...] [options]

参数:
  [prompt...]              单次提问的提示词（留空进入交互模式）

选项:
  -m, --model <model>      指定模型 (deepseek-v4-pro / deepseek-v4-flash)
  -p, --print              打印模式：执行提示词后退出
  -y, --yes                自动批准所有工具操作（谨慎使用）
  --api-key <key>          API 密钥（覆盖环境变量和配置文件）
  --thinking <mode>        推理显示：off | collapsed | full
  --show-thinking          --thinking full 的别名
  --hide-thinking          --thinking off 的别名
  --continue, --resume     恢复该项目上次保存的会话后执行
  -h, --help               显示帮助
  -V, --version            显示版本号
```

### 支持的模型

| 模型 ID | 名称 | 说明 |
|---------|------|------|
| `deepseek-v4-pro` | DeepSeek-V4 Pro | 旗舰版，适合复杂编程、推理和智能体工作 |
| `deepseek-v4-flash` | DeepSeek-V4 Flash | 快速经济版，适合日常编码任务 |

旧版别名 `deepseek-chat`、`deepseek-reasoner` 自动映射到默认模型。
对于 thinking 模型，CLI 会在带工具调用的回合里正确回传 `reasoning_content`，并在回合结束后清除，符合 DeepSeek 的接口约定。

## 开发

### 技术栈

- **语言**：TypeScript（strict，ES2022，NodeNext ESM）
- **运行时**：Node.js >= 18
- **核心依赖**：`openai`、`commander`、`chalk`、`@inquirer/prompts`、`diff`、`glob`
- **开发工具**：`tsx`（直跑 TS）、`tsc`（编译）

### 项目结构

```
src/
├── index.ts          入口：CLI 解析、API key 引导、一次性/REPL 分流、MCP 加载
├── agent.ts          智能体循环、检查点、子代理、Hook 触发、压缩
├── client.ts         DeepSeek 流式客户端（OpenAI 兼容，支持中断）
├── config.ts         配置、模型、thinking 模式、env 覆盖
├── permissions.ts    工具权限确认
├── commands.ts       全部斜杠命令
├── project.ts        项目记忆（DEEPSEEK.md）加载/初始化目标
├── session.ts        会话保存/恢复
├── skills.ts         自定义技能加载
├── plugins.ts        插件安装/市场/脚手架
├── mcp.ts            MCP stdio + HTTP/SSE 客户端
├── hooks.ts          工具/生命周期钩子
├── todo.ts           待办列表
├── btw.ts            "顺便提一句"待办 backlog
├── attachments.ts    拖拽路径解析
└── tools/            read/write/edit/bash/search_text/list_files/web_*/set_thinking/todo_*/task
```

### 常用命令

```bash
npm run dev                 # 开发模式运行（tsx 即时编译）
npm run dev -- "提示词"     # 开发模式单次提问
npm run typecheck           # 仅类型检查，不生成文件
npm run build               # 编译 TypeScript 到 dist/
npm start                   # 运行编译产物
```

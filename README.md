# DeepSeek CLI

基于 DeepSeek 模型的智能体编程命令行工具，提供类似 Claude Code 的交互体验——直接在终端中让 AI 阅读你的代码库、编辑文件、执行命令、搜索内容。

## 目录

- [快速开始](#快速开始)
- [核心概念](#核心概念)
  - [智能体循环](#智能体循环)
  - [工作模式](#工作模式)
  - [项目记忆](#项目记忆)
  - [会话管理](#会话管理)
  - [上下文压缩](#上下文压缩)
- [内置工具](#内置工具)
- [斜杠命令](#斜杠命令)
- [扩展能力](#扩展能力)
  - [自定义技能](#自定义技能)
  - [MCP 服务器](#mcp-服务器)
  - [工具钩子](#工具钩子)
  - [插件系统](#插件系统)
- [配置](#配置)
  - [配置文件](#配置文件)
  - [环境变量](#环境变量)
  - [CLI 参数](#cli-参数)
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

首次启动时如果没有设置环境变量，CLI 会提示你输入 API 密钥并可选保存到配置文件。

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
2. **理解**——自动读取项目文件（`DEEPSEEK.md`）、Git 状态、上次会话摘要
3. **规划**——需要多步骤时自动创建待办列表（`todo_write`）
4. **执行**——调用内置工具读取文件、搜索代码、运行命令、编辑文件
5. **验证**——每步操作都有结果反馈，出错了会自行修复
6. **循环**——反复执行直到完成任务（最多 25 轮工具调用）

核心循环位于 `src/agent.ts`，包含流式响应处理、推理内容管理、权限控制、Hook 触发和自动压缩。

### 工作模式

| 模式 | 用法 | 说明 |
|------|------|------|
| **交互 REPL** | `deepseek` | 多轮对话，支持多行输入（行末 `\` 续行） |
| **单次提问** | `deepseek "任务描述"` | 执行一次后打印结果退出 |
| **管道输入** | `echo "log内容" \| deepseek` | 标准输入作为提示词 |
| **恢复会话** | `deepseek --continue` | 恢复上次保存的项目会话 |
| **自动审批** | `deepseek --yes "修复lint错误"` | 跳过所有权限确认（谨慎使用） |

### 项目记忆

CLI 启动时会自动从项目目录中加载指令文件，优先级从根到当前目录：

- `DEEPSEEK.md` —— 项目专属指令文件
- `CLAUDE.md` —— 兼容 Claude Code 格式
- `AGENTS.md` —— 兼容其他 Agent CLI

这些文件的内容会注入到系统提示词中，让模型了解项目的技术栈、目录结构、构建命令和编码规范。

**记忆笔记**：在对话中随时输入 `# note 这个项目使用 PostgreSQL`，内容会自动追加到 `DEEPSEEK.md` 的 `## Notes` 段落。

**文件引用**：在提示词中使用 `@path/to/file.ts` 可自动内联文件内容（单文件上限 50,000 字符）。

**Shell 转义**：输入 `! ls -la` 直接执行 Shell 命令，不走 Agent 流程。

### 会话管理

每个项目的会话自动保存到 `~/.deepseek-cli/sessions/<hash>.json`（以项目绝对路径的 SHA256 哈希作为键）。

```bash
# 交互模式中
/save              # 手动保存当前会话
/resume            # 恢复上次保存的会话
/clear             # 清除对话历史及持久会话
```

```bash
# CLI 参数
deepseek --continue "继续上次的登录模块开发"
deepseek --resume   # 别名
```

### 上下文压缩

当对话达到约 **48,000 个 token** 或 **80 条消息**时，系统会自动压缩上下文：

- 将完整对话发送给 DeepSeek 模型生成**持续性摘要**
- 清空消息历史，将摘要注入下一轮系统提示词
- 你也可以手动触发：`/compress`

压缩摘要会随会话一起持久化，恢复会话时继续有效。

## 内置工具

| 工具 | 功能 | 需审批 |
|------|------|--------|
| `read_file` | 读取文件内容（支持偏移量和行数限制） | ✗ |
| `write_file` | 创建或覆盖文件（自动创建父目录） | ✓ |
| `edit_file` | 精确字符串替换编辑 | ✓ |
| `bash` | 执行 Shell 命令（超时可配，默认 120s，最长 600s） | ✓ |
| `search_text` | 正则搜索文件内容（优先使用 ripgrep） | ✗ |
| `list_files` | Glob 模式文件列表 | ✗ |
| `web_search` | 网页搜索 | ✗ |
| `web_fetch` | 获取网页内容（HTML 转纯文本） | ✗ |
| `set_thinking` | 开关推理显示的可见模式（off/collapsed/full） | ✗ |
| `todo_read` | 读取当前待办列表 | ✗ |
| `todo_write` | 创建/更新待办列表（同时只有一个 in_progress） | ✗ |

只读工具（`read_file`、`list_files`、`search_text`、`web_search`、`web_fetch`）**无需审批**；有副作用的工具（`write_file`、`edit_file`、`bash`）**需用户确认**。使用 `--yes` 可跳过所有确认。

## 斜杠命令

在交互模式中输入 `/` 前缀的命令：

| 命令 | 功能 |
|------|------|
| `/help`、`/?` | 显示帮助和命令列表 |
| `/init` | 分析项目并创建/更新 `DEEPSEEK.md` 指令文件 |
| `/model` | 方向键选择模型（从 API 获取或本地回退） |
| `/models` | 列出可用的 DeepSeek 模型 |
| `/thinking` | 控制推理过程显示（`off`/`collapsed`/`full`，不传参切换 on/off） |
| `/config` | 显示当前配置 |
| `/mcp <list\|init\|reload>` | 管理 MCP 标准输入输出服务器 |
| `/skills` | 列出所有自定义技能 |
| `/skill-new <name>` | 创建项目级技能模板 |
| `/plugin <list\|search\|install\|new\|remove\|...>` | 管理插件 |
| `/hooks [init\|list]` | 管理工具执行钩子 |
| `/review [ref]` | 审查 Git 改动（默认 `git diff HEAD`） |
| `/task <prompt>` | 隔离子任务，不污染主对话历史 |
| `/doctor` | 检查环境和配置健康状态 |
| `/compress` | 手动压缩上下文为持续摘要 |
| `/todos`、`/todo` | 显示当前待办任务列表 |
| `/tools` | 列出所有可用工具及其审批要求 |
| `/memory` | 显示加载的项目指令文件 |
| `/save` | 保存当前会话 |
| `/resume` | 恢复已保存会话 |
| `/usage` | 显示本次会话的 Token 用量和费用估算 |
| `/clear` | 清除对话历史和已保存会话 |
| `/exit`、`/quit`、`/q`、`exit`、`quit` | 退出（自动保存会话） |

**使用技巧**：
- 输入 `/` 后按 **Tab** 自动补全命令名
- 单独输入 `/` 浏览所有可用命令
- 输入错误命令会自动给出模糊匹配建议

## 扩展能力

### 自定义技能

技能是 Markdown 文件，带有 YAML 前置元数据，存放于：

- **项目级**：`.deepseek/skills/*.md`
- **全局级**：`~/.deepseek-cli/skills/*.md`

```bash
# 创建技能模板
deepseek
/skill-new deploy-staging

# 编辑 .deepseek/skills/deploy-staging.md
```

技能支持 `{{input}}`、`{{args}}`、`{{cwd}}` 占位符：

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

创建后自动生成为 `/deploy-staging` 命令。全局技能可被项目同名技能覆盖。

### MCP 服务器

Model Context Protocol (MCP) 支持加载外部工具，让模型访问数据库、API、设计稿等：

```bash
deepseek
/mcp init              # 创建 .deepseek/mcp.json 配置模板
# 编辑配置文件添加 MCP 服务器
/mcp reload            # 重新加载 MCP 工具
/mcp list              # 查看加载的工具和配置路径
```

配置文件格式（项目：`.deepseek/mcp.json`，全局：`~/.deepseek-cli/mcp.json`）：

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

兼容 Claude Code 格式：`.mcp.json`（使用 `mcpServers` 键）。加载后的工具以 `mcp__server__tool` 命名，执行前同样经过权限确认。

### 工具钩子

在工具执行前后自动运行 Shell 脚本（配置于 `.deepseek/hooks.json`）：

```bash
/hooks init           # 创建钩子配置模板
/hooks list           # 查看当前钩子
```

配置示例：

```json
{
  "preToolUse": [
    {
      "command": "eslint $DEEPSEEK_TOOL_PREVIEW",
      "continueOnError": true
    }
  ],
  "postToolUse": [
    {
      "command": "echo postToolUse:$DEEPSEEK_TOOL_NAME:$DEEPSEEK_TOOL_STATUS"
    }
  ]
}
```

环境变量：`DEEPSEEK_TOOL_NAME`、`DEEPSEEK_TOOL_PREVIEW`、`DEEPSEEK_TOOL_STATUS`（`success`/`error`）。`preToolUse` 钩子默认阻塞（失败时阻止工具执行），设置 `continueOnError: true` 可继续。

### 插件系统

通过 `/plugin` 命令安装和管理可复用扩展包：

```bash
/plugin search formatter              # 搜索市场插件
/plugin install my-plugin             # 安装插件
/plugin list                          # 列出已安装插件
/plugin new my-code-style             # 创建新插件脚手架
/plugin enable <name>                 # 启用插件
/plugin disable <name>                # 禁用插件
/plugin remove <name>                 # 移除插件
```

插件可以从市场、Git 仓库或本地路径安装，安装后自动导入技能和工具。

## 配置

### 配置文件

配置存储于 `~/.deepseek-cli/config.json`：

```json
{
  "baseURL": "https://api.deepseek.com",
  "model": "deepseek-v4-pro",
  "alwaysAllow": [],
  "thinkingMode": "collapsed"
}
```

- `apiKey`：可写入文件，但**从环境变量读取的密钥不会被持久化到磁盘**。
- `thinkingMode`：`off`（隐藏推理）/ `collapsed`（折叠显示前 6 行）/ `full`（完整显示）。
- `alwaysAllow`：始终免审批的工具名称列表。

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DEEPSEEK_API_KEY` | DeepSeek API 密钥 | 无（必填） |
| `DEEPSEEK_BASE_URL` | API 端点地址 | `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | 默认模型 | `deepseek-v4-pro` |
| `DEEPSEEK_THINKING` | 推理显示模式 | 配置文件设定 |
| `DEEPSEEK_PLUGIN_REGISTRY` | 插件市场索引地址 | 无（可选） |

环境变量优先级**高于**配置文件。旧版兼容：`DEEPSEEK_SHOW_THINKING` 仍可工作。

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

### 目前支持的模型

| 模型 ID | 名称 | 说明 |
|---------|------|------|
| `deepseek-v4-pro` | DeepSeek-V4 Pro | 旗舰版，适合复杂编程、推理和智能体工作 |
| `deepseek-v4-flash` | DeepSeek-V4 Flash | 快速经济版，适合日常编码任务 |

旧版别名兼容：`deepseek-chat`、`deepseek-reasoner` 自动映射到默认模型。

## 开发

### 技术栈

- **语言**：TypeScript（strict 模式，ES2022，NodeNext ESM 模块）
- **运行时**：Node.js >= 18
- **核心依赖**：`openai` ^4.77、`commander` ^12.1、`chalk` ^5.3、`@inquirer/prompts` ^7.2、`diff` ^7.0、`glob` ^11.0
- **开发工具**：`tsx`（直接运行 TS）、`tsc`（编译）

### 常用命令

```bash
npm run dev                 # 开发模式运行（tsx 即时编译）
npm run dev -- "提示词"     # 开发模式单次提问
npm run typecheck           # 仅类型检查，不生成文件
npm run build               # 编译 TypeScript 到 dist/
npm start                   # 运行编译产物
```

编译后 `dist/index.js` 注册为 `deepseek` 命令（通过 package.json 的 `bin` 字段）。

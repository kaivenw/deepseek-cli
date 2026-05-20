import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Tool } from "./tools/types.js";
import { findProjectRoot } from "./project.js";

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
  timeoutMs?: number;
}

interface McpConfig {
  servers?: Record<string, McpServerConfig>;
  mcpServers?: Record<string, McpServerConfig>;
}

interface JsonRpcResponse {
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolInfo {
  toolName: string;
  serverName: string;
  remoteName: string;
  description: string;
}

export interface McpLoadResult {
  tools: Tool[];
  infos: McpToolInfo[];
  errors: string[];
}

const CONFIG_DIR = path.join(os.homedir(), ".deepseek-cli");
const GLOBAL_MCP_PATH = path.join(CONFIG_DIR, "mcp.json");
const PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_TIMEOUT_MS = 30_000;

let loadedInfos: McpToolInfo[] = [];
let loadedErrors: string[] = [];
const clients = new Map<string, McpStdioClient>();

export function globalMcpPath(): string {
  return GLOBAL_MCP_PATH;
}

export function projectMcpPath(cwd: string): string {
  return path.join(findProjectRoot(cwd), ".deepseek", "mcp.json");
}

export function claudeMcpPath(cwd: string): string {
  return path.join(findProjectRoot(cwd), ".mcp.json");
}

export function mcpStatus(): { infos: McpToolInfo[]; errors: string[] } {
  return { infos: [...loadedInfos], errors: [...loadedErrors] };
}

export function createMcpTemplate(cwd: string, scope: "project" | "global" = "project"): { path: string; created: boolean } {
  const file = scope === "global" ? GLOBAL_MCP_PATH : projectMcpPath(cwd);
  if (fs.existsSync(file)) return { path: file, created: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const template: McpConfig = {
    servers: {
      // Replace this with a real MCP stdio server.
      example: {
        command: "node",
        args: ["/absolute/path/to/mcp-server.js"],
        disabled: true,
      },
    },
  };
  fs.writeFileSync(file, JSON.stringify(template, null, 2) + "\n", "utf8");
  return { path: file, created: true };
}

function readJson(file: string): McpConfig {
  try {
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as McpConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function serversFromConfig(config: McpConfig): Record<string, McpServerConfig> {
  return { ...(config.mcpServers ?? {}), ...(config.servers ?? {}) };
}

function loadConfig(cwd: string): Record<string, McpServerConfig> {
  const root = findProjectRoot(cwd);
  const globalConfig = serversFromConfig(readJson(GLOBAL_MCP_PATH));
  const claudeProjectConfig = serversFromConfig(readJson(path.join(root, ".mcp.json")));
  const projectConfig = serversFromConfig(readJson(projectMcpPath(cwd)));
  return { ...globalConfig, ...claudeProjectConfig, ...projectConfig };
}

function sanitizeToolPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "tool";
}

function mcpToolName(serverName: string, remoteName: string): string {
  return `mcp__${sanitizeToolPart(serverName)}__${sanitizeToolPart(remoteName)}`.slice(0, 64);
}

function textFromMcpResult(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (!item || typeof item !== "object") return String(item);
      const record = item as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (typeof record.data === "string") return record.data;
      return JSON.stringify(record);
    }).join("\n");
  }
  if (typeof content === "string") return content;
  if (result === undefined) return "";
  return JSON.stringify(result, null, 2);
}

class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private buffer = "";
  private pending = new Map<number, { resolve(value: unknown): void; reject(err: Error): void; timer: NodeJS.Timeout }>();
  private initialized = false;

  constructor(
    private serverName: string,
    private config: McpServerConfig,
    private baseCwd: string,
  ) {}

  private timeoutMs(): number {
    return Math.min(Math.max(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000), 600_000);
  }

  private start(): void {
    if (this.child) return;
    const cwd = this.config.cwd ? path.resolve(this.baseCwd, this.config.cwd) : this.baseCwd;
    this.child = spawn(this.config.command, this.config.args ?? [], {
      cwd,
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.on("exit", () => {
      this.child = null;
      this.initialized = false;
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`MCP server ${this.serverName} exited.`));
      }
      this.pending.clear();
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;
      const raw = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!raw) continue;
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(raw) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (message.id === undefined) continue;
      const id = Number(message.id);
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? `MCP error ${message.error.code ?? "unknown"}`));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    this.start();
    const child = this.child;
    if (!child) return Promise.reject(new Error(`Could not start MCP server ${this.serverName}.`));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${this.serverName}.${method}`));
      }, this.timeoutMs());
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(payload, "utf8");
    });
  }

  private notify(method: string, params?: unknown): void {
    this.start();
    this.child?.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n", "utf8");
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "deepseek-cli", version: "0.1.0" },
    });
    this.notify("notifications/initialized");
    this.initialized = true;
  }

  async listTools(): Promise<McpToolDefinition[]> {
    await this.initialize();
    const result = await this.request("tools/list", {});
    const tools = (result as { tools?: unknown })?.tools;
    return Array.isArray(tools) ? tools.filter((tool): tool is McpToolDefinition => {
      return !!tool && typeof (tool as McpToolDefinition).name === "string";
    }) : [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    await this.initialize();
    const result = await this.request("tools/call", { name, arguments: args });
    return textFromMcpResult(result);
  }

  shutdown(): void {
    this.child?.kill();
    this.child = null;
  }
}

function toolFromMcp(client: McpStdioClient, serverName: string, remote: McpToolDefinition): { tool: Tool; info: McpToolInfo } {
  const toolName = mcpToolName(serverName, remote.name);
  const description = remote.description || `MCP tool ${remote.name} from ${serverName}`;
  const info: McpToolInfo = { toolName, serverName, remoteName: remote.name, description };
  const tool: Tool = {
    name: toolName,
    description: `[MCP:${serverName}] ${description}`,
    needsApproval: true,
    parameters: remote.inputSchema ?? { type: "object", properties: {} },
    preview(args) {
      const argText = Object.keys(args).length > 0 ? ` ${JSON.stringify(args).slice(0, 160)}` : "";
      return `mcp ${serverName}.${remote.name}${argText}`;
    },
    async run(args) {
      try {
        const output = await client.callTool(remote.name, args);
        return {
          content: output || `(MCP ${serverName}.${remote.name} returned no content)`,
          summary: `mcp ${serverName}.${remote.name}`,
        };
      } catch (err) {
        return {
          content: `Error calling MCP tool ${serverName}.${remote.name}: ${(err as Error).message}`,
          summary: `mcp ${serverName}.${remote.name} failed`,
          isError: true,
        };
      }
    },
  };
  return { tool, info };
}

export async function loadMcpTools(cwd: string): Promise<McpLoadResult> {
  shutdownMcp();
  loadedInfos = [];
  loadedErrors = [];
  const tools: Tool[] = [];
  const servers = loadConfig(cwd);

  for (const [serverName, config] of Object.entries(servers)) {
    if (!config || config.disabled) continue;
    if (!config.command) {
      loadedErrors.push(`${serverName}: missing command`);
      continue;
    }
    const client = new McpStdioClient(serverName, config, cwd);
    clients.set(serverName, client);
    try {
      const remoteTools = await client.listTools();
      for (const remote of remoteTools) {
        const wrapped = toolFromMcp(client, serverName, remote);
        tools.push(wrapped.tool);
        loadedInfos.push(wrapped.info);
      }
    } catch (err) {
      loadedErrors.push(`${serverName}: ${(err as Error).message}`);
      client.shutdown();
      clients.delete(serverName);
    }
  }

  return { tools, infos: [...loadedInfos], errors: [...loadedErrors] };
}

export function shutdownMcp(): void {
  for (const client of clients.values()) client.shutdown();
  clients.clear();
}

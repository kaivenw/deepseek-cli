import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ModelInfo {
  id: string;
  label: string;
  supportsTools: boolean;
  /** Whether the model accepts image input. DeepSeek chat models are text-only. */
  supportsVision?: boolean;
  description: string;
}

export const MODELS: ModelInfo[] = [
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek-V4 Pro",
    supportsTools: true,
    description: "Flagship V4 model. Best for complex coding, reasoning, and agentic work.",
  },
  {
    id: "deepseek-v4-flash",
    label: "DeepSeek-V4 Flash",
    supportsTools: true,
    description: "Fast and cost-efficient V4 model for everyday coding tasks.",
  },
];

export const DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_MODEL = "deepseek-v4-pro";

/** How the model's reasoning/thinking trace is displayed in the terminal. */
export type ThinkingMode = "off" | "collapsed" | "full";

export function normalizeThinkingMode(value: unknown): ThinkingMode | undefined {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "off" || v === "hide" || v === "none") return "off";
  if (v === "collapsed" || v === "short" || v === "fold") return "collapsed";
  if (v === "full" || v === "on" || v === "show" || v === "all") return "full";
  return undefined;
}

const LEGACY_MODEL_ALIASES: Record<string, string> = {
  "deepseek-chat": DEFAULT_MODEL,
  "deepseek-reasoner": DEFAULT_MODEL,
};

export interface Config {
  apiKey?: string;
  baseURL: string;
  model: string;
  /** Tools auto-approved without prompting for the persisted config. */
  alwaysAllow: string[];
  /** How the model's reasoning/thinking trace is displayed (off | collapsed | full). */
  thinkingMode: ThinkingMode;
  /** True after the user explicitly persists a thinking display preference. */
  thinkingModeConfigured?: boolean;
  /** True when the key came from the environment — don't persist it to disk. */
  apiKeyFromEnv?: boolean;
}

const CONFIG_DIR = path.join(os.homedir(), ".deepseek-cli");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const DEFAULTS: Config = {
  baseURL: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  alwaysAllow: [],
  thinkingMode: "off",
};

export function loadConfig(): Config {
  let fileConfig: Partial<Config> = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    }
  } catch {
    // Corrupt config: fall back to defaults rather than crashing.
  }

  const savedThinkingMode = normalizeThinkingMode(fileConfig.thinkingMode);
  const thinkingModeConfigured = fileConfig.thinkingModeConfigured === true;

  const config: Config = {
    ...DEFAULTS,
    ...fileConfig,
    alwaysAllow: fileConfig.alwaysAllow ?? [],
    thinkingMode: thinkingModeConfigured ? (savedThinkingMode ?? DEFAULTS.thinkingMode) : DEFAULTS.thinkingMode,
    thinkingModeConfigured,
  };

  // Environment variables take precedence over the stored file.
  if (process.env.DEEPSEEK_API_KEY) {
    config.apiKey = process.env.DEEPSEEK_API_KEY;
    config.apiKeyFromEnv = true;
  }
  if (process.env.DEEPSEEK_BASE_URL) config.baseURL = process.env.DEEPSEEK_BASE_URL;
  if (process.env.DEEPSEEK_MODEL) config.model = process.env.DEEPSEEK_MODEL;
  // DEEPSEEK_THINKING (off|collapsed|full) wins; legacy DEEPSEEK_SHOW_THINKING still honored.
  const envThinking = normalizeThinkingMode(process.env.DEEPSEEK_THINKING);
  if (envThinking) {
    config.thinkingMode = envThinking;
  } else if (process.env.DEEPSEEK_SHOW_THINKING) {
    const v = process.env.DEEPSEEK_SHOW_THINKING.trim().toLowerCase();
    config.thinkingMode = ["0", "false", "no", "off"].includes(v) ? "off" : "full";
  }

  config.model = LEGACY_MODEL_ALIASES[config.model] ?? config.model;

  return config;
}

export function saveConfig(config: Config): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const toStore: Record<string, unknown> = {
    baseURL: config.baseURL,
    model: config.model,
    alwaysAllow: config.alwaysAllow,
  };
  if (config.thinkingModeConfigured) {
    toStore.thinkingMode = config.thinkingMode;
    toStore.thinkingModeConfigured = true;
  }
  // Never write an environment-provided key to disk.
  if (config.apiKey && !config.apiKeyFromEnv) toStore.apiKey = config.apiKey;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(toStore, null, 2), "utf8");
}

export function configPath(): string {
  return CONFIG_PATH;
}

export function findModel(id: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id);
}

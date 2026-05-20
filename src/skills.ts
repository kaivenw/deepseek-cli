import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findProjectRoot } from "./project.js";

export interface SkillCommand {
  name: string;
  usage: string;
  description: string;
  prompt: string;
  source: string;
  scope: "project" | "global";
}

interface ParsedSkillFile {
  metadata: Record<string, string>;
  body: string;
}

const SKILL_DIR = path.join(".deepseek", "skills");
const GLOBAL_SKILL_DIR = path.join(os.homedir(), ".deepseek-cli", "skills");

function normalizeCommandName(value: string): string {
  return value
    .trim()
    .replace(/^\//, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseSkillFile(raw: string): ParsedSkillFile {
  if (!raw.startsWith("---\n")) return { metadata: {}, body: raw.trim() };

  const end = raw.indexOf("\n---", 4);
  if (end === -1) return { metadata: {}, body: raw.trim() };

  const frontmatter = raw.slice(4, end).trim();
  const body = raw.slice(end + "\n---".length).trim();
  const metadata: Record<string, string> = {};

  for (const line of frontmatter.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim().replace(/^['\"]|['\"]$/g, "");
    if (key && value) metadata[key] = value;
  }

  return { metadata, body };
}

function readSkillFile(file: string, scope: SkillCommand["scope"]): SkillCommand | null {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = parseSkillFile(raw);
    const inferredName = path.basename(file, path.extname(file));
    const name = normalizeCommandName(parsed.metadata.command ?? parsed.metadata.name ?? inferredName);
    if (!name) return null;

    return {
      name,
      usage: `/${name}`,
      description: parsed.metadata.description ?? parsed.metadata.summary ?? "custom skill",
      prompt: parsed.body,
      source: file,
      scope,
    };
  } catch {
    return null;
  }
}

function loadSkillDir(dir: string, scope: SkillCommand["scope"]): SkillCommand[] {
  if (!fs.existsSync(dir)) return [];
  const skills: SkillCommand[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const skill = readSkillFile(path.join(dir, entry.name), scope);
    if (skill) skills.push(skill);
  }

  return skills;
}

export function projectSkillDir(cwd: string): string {
  return path.join(findProjectRoot(cwd), SKILL_DIR);
}

export function globalSkillDir(): string {
  return GLOBAL_SKILL_DIR;
}

export function loadSkillCommands(cwd: string): SkillCommand[] {
  const merged = new Map<string, SkillCommand>();

  for (const skill of loadSkillDir(GLOBAL_SKILL_DIR, "global")) {
    merged.set(skill.name, skill);
  }
  for (const skill of loadSkillDir(projectSkillDir(cwd), "project")) {
    merged.set(skill.name, skill);
  }

  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findSkillCommand(cwd: string, name: string): SkillCommand | undefined {
  const normalized = normalizeCommandName(name);
  return loadSkillCommands(cwd).find((skill) => skill.name === normalized);
}

export function createSkillTemplate(cwd: string, rawName: string): { created: boolean; path: string } {
  const name = normalizeCommandName(rawName);
  if (!name) throw new Error("Skill name must contain letters or numbers.");

  const dir = projectSkillDir(cwd);
  const file = path.join(dir, `${name}.md`);
  if (fs.existsSync(file)) return { created: false, path: file };

  fs.mkdirSync(dir, { recursive: true });
  const title = name
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
  const content = [
    "---",
    `name: ${name}`,
    `description: ${title} task`,
    "---",
    "",
    `You are running the custom /${name} skill.`,
    "",
    "User input:",
    "{{input}}",
    "",
    "Instructions:",
    "- Describe exactly what this skill should do.",
    "- Mention which files or commands it should inspect when relevant.",
    "- Keep the final answer concise and actionable.",
    "",
  ].join("\n");
  fs.writeFileSync(file, content, "utf8");

  return { created: true, path: file };
}

export function renderSkillPrompt(skill: SkillCommand, input: string, cwd: string): string {
  const args = input.trim();
  const rendered = skill.prompt
    .replaceAll("{{input}}", args)
    .replaceAll("{{args}}", args)
    .replaceAll("{{cwd}}", cwd);

  const includesInput = skill.prompt.includes("{{input}}") || skill.prompt.includes("{{args}}");
  return [
    `Run custom skill /${skill.name}.`,
    `Skill file: ${skill.source}`,
    `Description: ${skill.description}`,
    "",
    rendered,
    includesInput ? "" : `\nUser input: ${args || "(none)"}`,
  ].join("\n").trim();
}

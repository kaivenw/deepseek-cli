import fs from "node:fs";
import path from "node:path";

export const PROJECT_MEMORY_FILES = ["DEEPSEEK.md", "CLAUDE.md", "AGENTS.md"] as const;

const ROOT_MARKERS = [
  "package.json",
  ".git",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
];
const MAX_MEMORY_CHARS_PER_FILE = 30_000;

export interface ProjectMemory {
  root: string;
  files: string[];
  content: string;
}

export interface InitProjectMemoryResult {
  created: boolean;
  path: string;
  root: string;
  message: string;
}

export function findProjectRoot(cwd: string): string {
  let current = path.resolve(cwd);

  while (true) {
    if (ROOT_MARKERS.some((marker) => fs.existsSync(path.join(current, marker)))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
}

function dirsFromRootToCwd(root: string, cwd: string): string[] {
  const resolvedRoot = path.resolve(root);
  const resolvedCwd = path.resolve(cwd);
  const relative = path.relative(resolvedRoot, resolvedCwd);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return [resolvedRoot];
  }

  const dirs = [resolvedRoot];
  let current = resolvedRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    dirs.push(current);
  }
  return dirs;
}

function readTextFile(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function findProjectMemoryFiles(cwd: string): { root: string; files: string[] } {
  const root = findProjectRoot(cwd);
  const files: string[] = [];

  for (const dir of dirsFromRootToCwd(root, cwd)) {
    for (const name of PROJECT_MEMORY_FILES) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) files.push(file);
    }
  }

  return { root, files };
}

export function loadProjectMemory(cwd: string): ProjectMemory {
  const { root, files } = findProjectMemoryFiles(cwd);
  const sections: string[] = [];

  for (const file of files) {
    const raw = readTextFile(file);
    if (!raw) continue;

    const relativePath = path.relative(root, file) || path.basename(file);
    const clipped =
      raw.length > MAX_MEMORY_CHARS_PER_FILE
        ? raw.slice(0, MAX_MEMORY_CHARS_PER_FILE) + "\n...[project instructions truncated]"
        : raw;
    sections.push(`--- ${relativePath} ---\n${clipped.trim()}`);
  }

  return {
    root,
    files,
    content: sections.join("\n\n"),
  };
}

export function formatProjectMemoryForPrompt(cwd: string): string {
  const memory = loadProjectMemory(cwd);
  if (!memory.content) return "";

  return [
    "Project instructions:",
    "The following files are maintained by the user/project. Follow them when working in this repository.",
    memory.content,
  ].join("\n");
}

function readPackageJson(root: string): Record<string, unknown> | null {
  const file = path.join(root, "package.json");
  const raw = readTextFile(file);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function listScripts(pkg: Record<string, unknown> | null): string[] {
  const scripts = pkg?.scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return [];

  return Object.entries(scripts as Record<string, unknown>)
    .filter(([, value]) => typeof value === "string")
    .map(([name, value]) => `- \`npm run ${name}\`: ${value}`);
}

function detectStack(root: string, pkg: Record<string, unknown> | null): string[] {
  const stack: string[] = [];

  if (pkg) stack.push("Node.js");
  if (fs.existsSync(path.join(root, "tsconfig.json"))) stack.push("TypeScript");
  if (fs.existsSync(path.join(root, "package-lock.json"))) stack.push("npm");
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) stack.push("pnpm");
  if (fs.existsSync(path.join(root, "yarn.lock"))) stack.push("Yarn");
  if (fs.existsSync(path.join(root, "src"))) stack.push("source in `src/`");

  return stack;
}

export function initProjectMemory(cwd: string): InitProjectMemoryResult {
  const root = findProjectRoot(cwd);
  const target = path.join(root, "DEEPSEEK.md");

  if (fs.existsSync(target)) {
    return {
      created: false,
      path: target,
      root,
      message: "DEEPSEEK.md already exists.",
    };
  }

  const pkg = readPackageJson(root);
  const projectName =
    typeof pkg?.name === "string" && pkg.name.trim() ? pkg.name.trim() : path.basename(root);
  const description =
    typeof pkg?.description === "string" && pkg.description.trim()
      ? pkg.description.trim()
      : "Add a short project description here.";
  const stack = detectStack(root, pkg);
  const scripts = listScripts(pkg);

  const content = [
    `# ${projectName} Project Instructions`,
    "",
    "## Project Overview",
    `- Purpose: ${description}`,
    stack.length > 0 ? `- Stack: ${stack.join(", ")}` : "- Stack: Add the primary runtime/frameworks here.",
    "",
    "## Common Commands",
    ...(scripts.length > 0 ? scripts : ["- Add build, test, lint, and dev commands here."]),
    "",
    "## Working Guidelines",
    "- Read the relevant files before changing code.",
    "- Keep changes focused on the requested behavior.",
    "- Run type checking, builds, or targeted tests after code changes when available.",
    "- Do not commit secrets or local environment files.",
    "",
    "## Project Notes",
    "- Add domain rules, architecture decisions, and conventions that DeepSeek CLI should follow here.",
    "",
  ].join("\n");

  fs.writeFileSync(target, content, "utf8");

  return {
    created: true,
    path: target,
    root,
    message: "Created DEEPSEEK.md.",
  };
}

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

export function projectMemoryTarget(cwd: string): string {
  return path.join(findProjectRoot(cwd), "DEEPSEEK.md");
}

/** Append a quick note under a "## Notes" section in DEEPSEEK.md (creating it if needed). */
export function appendProjectMemory(cwd: string, note: string): string {
  const target = projectMemoryTarget(cwd);
  const line = `- ${note.trim()}`;
  let body = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "# Project Notes\n";

  const idx = body.indexOf("## Notes");
  if (idx === -1) {
    body = body.trimEnd() + "\n\n## Notes\n" + line + "\n";
  } else {
    const headerEnd = body.indexOf("\n", idx);
    const insertAt = headerEnd === -1 ? body.length : headerEnd + 1;
    body = body.slice(0, insertAt) + line + "\n" + body.slice(insertAt);
  }
  fs.writeFileSync(target, body, "utf8");
  return target;
}

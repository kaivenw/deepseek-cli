import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const HISTORY_DIR = path.join(os.homedir(), ".deepseek-cli", "history");
const MAX_ENTRIES = 500;

function historyPath(cwd: string): string {
  const hash = crypto.createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 16);
  return path.join(HISTORY_DIR, `${hash}.json`);
}

/** Load this project's persisted input history (oldest → newest). */
export function loadHistory(cwd: string): string[] {
  try {
    const raw = fs.readFileSync(historyPath(cwd), "utf8");
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      return data.filter((entry): entry is string => typeof entry === "string").slice(-MAX_ENTRIES);
    }
  } catch {
    // No history yet, or unreadable — start empty.
  }
  return [];
}

/** Persist this project's input history (best-effort; capped to the most recent entries). */
export function saveHistory(cwd: string, history: string[]): void {
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    fs.writeFileSync(historyPath(cwd), JSON.stringify(history.slice(-MAX_ENTRIES)), "utf8");
  } catch {
    // Best-effort: a failure to persist history shouldn't break the session.
  }
}

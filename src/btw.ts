import fs from "node:fs";
import path from "node:path";
import { findProjectRoot } from "./project.js";

export interface BtwNote {
  text: string;
  createdAt: string;
}

interface BtwStore {
  notes: BtwNote[];
}

export function btwPath(cwd: string): string {
  return path.join(findProjectRoot(cwd), ".deepseek", "btw.json");
}

function load(cwd: string): BtwStore {
  const file = btwPath(cwd);
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as BtwStore;
      if (Array.isArray(parsed.notes)) return parsed;
    }
  } catch {
    // Corrupt store: start fresh rather than crashing.
  }
  return { notes: [] };
}

function save(cwd: string, store: BtwStore): void {
  const file = btwPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(store, null, 2), "utf8");
}

export function addNote(cwd: string, text: string): BtwNote {
  const store = load(cwd);
  const note: BtwNote = { text: text.trim(), createdAt: new Date().toISOString() };
  store.notes.push(note);
  save(cwd, store);
  return note;
}

export function listNotes(cwd: string): BtwNote[] {
  return load(cwd).notes;
}

/** Remove a note by 1-based index. Returns the removed note or null. */
export function removeNote(cwd: string, index: number): BtwNote | null {
  const store = load(cwd);
  if (index < 1 || index > store.notes.length) return null;
  const [removed] = store.notes.splice(index - 1, 1);
  save(cwd, store);
  return removed ?? null;
}

/** Clear all notes. Returns how many were removed. */
export function clearNotes(cwd: string): number {
  const store = load(cwd);
  const count = store.notes.length;
  save(cwd, { notes: [] });
  return count;
}

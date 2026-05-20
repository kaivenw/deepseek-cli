export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;

export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

export interface TodoInput {
  id?: string;
  content: string;
  status: TodoStatus;
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && TODO_STATUSES.includes(value as TodoStatus);
}

function fallbackId(index: number): string {
  return `todo-${index + 1}`;
}

export function validateTodos(rawTodos: unknown): { todos?: TodoItem[]; error?: string } {
  if (!Array.isArray(rawTodos)) {
    return { error: "todos must be an array." };
  }

  const ids = new Set<string>();
  const todos: TodoItem[] = [];

  for (let i = 0; i < rawTodos.length; i++) {
    const raw = rawTodos[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { error: `todo ${i + 1} must be an object.` };
    }

    const item = raw as Record<string, unknown>;
    const content = typeof item.content === "string" ? item.content.trim() : "";
    if (!content) {
      return { error: `todo ${i + 1} content must be a non-empty string.` };
    }
    if (!isTodoStatus(item.status)) {
      return {
        error: `todo ${i + 1} status must be one of: ${TODO_STATUSES.join(", ")}.`,
      };
    }

    const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : fallbackId(i);
    if (ids.has(id)) {
      return { error: `duplicate todo id: ${id}.` };
    }
    ids.add(id);

    todos.push({ id, content, status: item.status });
  }

  const inProgress = todos.filter((todo) => todo.status === "in_progress");
  if (inProgress.length > 1) {
    return { error: "only one todo may be in_progress at a time." };
  }

  return { todos };
}

export class TodoStore {
  private todos: TodoItem[] = [];

  list(): TodoItem[] {
    return this.todos.map((todo) => ({ ...todo }));
  }

  replace(todos: TodoItem[]): void {
    this.todos = todos.map((todo) => ({ ...todo }));
  }

  clear(): void {
    this.todos = [];
  }

  formatForModel(): string {
    return formatTodoList(this.todos);
  }
}

export function formatTodoList(todos: TodoItem[]): string {
  if (todos.length === 0) return "No active todos.";

  const marker: Record<TodoStatus, string> = {
    pending: "[ ]",
    in_progress: "[>]",
    completed: "[x]",
  };

  return todos.map((todo) => `${marker[todo.status]} ${todo.content} (${todo.id})`).join("\n");
}

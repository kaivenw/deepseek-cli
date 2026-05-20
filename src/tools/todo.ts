import type { Tool } from "./types.js";
import { formatTodoList, validateTodos } from "../todo.js";

export const todoReadTool: Tool = {
  name: "todo_read",
  description:
    "Read the current task list. Use this before updating todos when you are not sure what is already tracked.",
  needsApproval: false,
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  async run(_args, ctx) {
    const todos = ctx.todoStore?.list() ?? [];
    const formatted = formatTodoList(todos);
    return {
      content: formatted,
      summary: todos.length === 0 ? "todos: none" : `todos: ${todos.length} item${todos.length === 1 ? "" : "s"}`,
      display: formatted,
    };
  },
};

export const todoWriteTool: Tool = {
  name: "todo_write",
  description:
    "Create or update the session task list for multi-step work. Use this for non-trivial coding tasks, keeping exactly one item in_progress at a time. " +
    "Replace the whole list each time with concise pending/in_progress/completed items.",
  needsApproval: false,
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "The complete replacement todo list.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable short id, e.g. inspect, implement, verify." },
            content: { type: "string", description: "Concise task text." },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
              description: "Current task status. Only one item may be in_progress.",
            },
          },
          required: ["content", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["todos"],
    additionalProperties: false,
  },
  preview(args) {
    const count = Array.isArray(args.todos) ? args.todos.length : 0;
    return `update todo list (${count} item${count === 1 ? "" : "s"})`;
  },
  async run(args, ctx) {
    if (!ctx.todoStore) {
      return { content: "Error: todo store is unavailable.", isError: true };
    }

    const result = validateTodos(args.todos);
    if (result.error) {
      return { content: `Error: ${result.error}`, isError: true };
    }

    const todos = result.todos ?? [];
    ctx.todoStore.replace(todos);
    const formatted = formatTodoList(todos);
    return {
      content: `Todo list updated.\n${formatted}`,
      summary: todos.length === 0 ? "todos cleared" : `todos updated (${todos.length})`,
      display: formatted,
    };
  },
};

import type CodexForObsidianPlugin from "../main";
import type { EchoInkTodoCategory, EchoInkTodoItem } from "../settings/settings";
import { newId } from "../settings/settings";
import { dateKey } from "./home-workbench-model";

export type EchoInkTodoDueState = "overdue" | "today" | "future" | "none";

/** Local calendar date key for "today"; no timezone conversion. */
export function todayKey(): string {
  const now = new Date();
  return dateKey(now);
}

export function todoDueState(todo: EchoInkTodoItem, today = todayKey()): EchoInkTodoDueState {
  if (!todo.dueDate) return "none";
  if (todo.dueDate < today) return "overdue";
  if (todo.dueDate === today) return "today";
  return "future";
}

/**
 * Open todos first, nearest due date first, undated last; completed todos keep
 * their own recency order inside the "all" view.
 */
export function sortOpenTodos(todos: readonly EchoInkTodoItem[]): EchoInkTodoItem[] {
  return todos
    .filter((todo) => !todo.done)
    .sort((a, b) => {
      if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
      if (a.dueDate && !b.dueDate) return -1;
      if (!a.dueDate && b.dueDate) return 1;
      return a.createdAt - b.createdAt;
    });
}

export function todoCategoryName(
  categories: readonly EchoInkTodoCategory[],
  categoryId: string,
  uncategorizedLabel: string
): string {
  const match = categories.find((category) => category.id === categoryId);
  return match?.name.trim() || uncategorizedLabel;
}

export async function saveTodos(plugin: CodexForObsidianPlugin): Promise<void> {
  await plugin.saveSettings();
  plugin.notifyHomeSurfacesChanged();
}

export function createTodo(
  plugin: CodexForObsidianPlugin,
  input: { title: string; people?: string; dueDate?: string; categoryId?: string }
): EchoInkTodoItem {
  const todo: EchoInkTodoItem = {
    id: newId("todo"),
    title: input.title.trim(),
    people: (input.people ?? "").trim(),
    dueDate: input.dueDate ?? "",
    categoryId: input.categoryId ?? "",
    done: false,
    createdAt: Date.now(),
    completedAt: null
  };
  plugin.settings.todos.push(todo);
  return todo;
}

export function updateTodo(
  plugin: CodexForObsidianPlugin,
  id: string,
  patch: Partial<Pick<EchoInkTodoItem, "title" | "people" | "dueDate" | "categoryId">>
): EchoInkTodoItem | null {
  const todo = plugin.settings.todos.find((entry) => entry.id === id);
  if (!todo) return null;
  if (patch.title !== undefined) todo.title = patch.title.trim();
  if (patch.people !== undefined) todo.people = patch.people.trim();
  if (patch.dueDate !== undefined) todo.dueDate = patch.dueDate;
  if (patch.categoryId !== undefined) todo.categoryId = patch.categoryId;
  return todo;
}

export function setTodoDone(plugin: CodexForObsidianPlugin, id: string, done: boolean): EchoInkTodoItem | null {
  const todo = plugin.settings.todos.find((entry) => entry.id === id);
  if (!todo) return null;
  todo.done = done;
  todo.completedAt = done ? Date.now() : null;
  return todo;
}

export function removeTodo(plugin: CodexForObsidianPlugin, id: string): boolean {
  const index = plugin.settings.todos.findIndex((entry) => entry.id === id);
  if (index < 0) return false;
  plugin.settings.todos.splice(index, 1);
  return true;
}

export function addTodoCategory(plugin: CodexForObsidianPlugin, name: string): EchoInkTodoCategory | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (plugin.settings.todoCategories.some((category) => category.name === trimmed)) return null;
  const category: EchoInkTodoCategory = { id: newId("todo-category"), name: trimmed };
  plugin.settings.todoCategories.push(category);
  return category;
}

export function renameTodoCategory(plugin: CodexForObsidianPlugin, id: string, name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (plugin.settings.todoCategories.some((category) => category.id !== id && category.name === trimmed)) return false;
  const category = plugin.settings.todoCategories.find((entry) => entry.id === id);
  if (!category) return false;
  category.name = trimmed;
  return true;
}

/** Deleting a category keeps todos; they fall back to uncategorized. */
export function removeTodoCategory(plugin: CodexForObsidianPlugin, id: string): boolean {
  const index = plugin.settings.todoCategories.findIndex((entry) => entry.id === id);
  if (index < 0) return false;
  plugin.settings.todoCategories.splice(index, 1);
  for (const todo of plugin.settings.todos) {
    if (todo.categoryId === id) todo.categoryId = "";
  }
  return true;
}

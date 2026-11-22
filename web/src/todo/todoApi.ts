// 할 일 API(공개 전 기능, 허용된 계정만). 허용되지 않으면 서버가 모든 주소에 404를 준다
import { ApiError } from "../api";

export interface TodoCategory {
  id: string;
  name: string;
  color: string;
  visibility: "public" | "friends" | "private";
  memo_shared: boolean;
  closed: boolean;
}

export interface TodoItem {
  id: string;
  category_id: string;
  title: string;
  memo: string;
  day: string;
  time: string | null;
  place: string | null;
  done: boolean;
  source: string;
  position: number;
}

export interface TodoDay {
  day: string;
  categories: TodoCategory[];
  items: TodoItem[];
}

export type DaySummary = Record<string, { total: number; done: number }>;

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    let code = "";
    try {
      const data = (await response.json()) as { detail?: unknown };
      if (typeof data.detail === "string") code = data.detail;
    } catch {
      // 본문이 없거나 JSON이 아니면 상태 코드만
    }
    throw new ApiError(response.status, code);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const fetchTodoDay = (day: string) => call<TodoDay>(`/api/todo/day/${encodeURIComponent(day)}`);

export const fetchTodoDays = async (start: string, end: string): Promise<DaySummary> =>
  (await call<{ days: DaySummary }>(`/api/todo/days?start=${start}&end=${end}`)).days;

export interface NewTodo {
  title: string;
  day: string;
  category_id: string;
  time?: string | null;
  place?: string | null;
  memo?: string;
}

export const addTodo = (todo: NewTodo) => call<TodoItem>("/api/todo/items", "POST", todo);

export type TodoChanges = Partial<Pick<TodoItem, "title" | "memo" | "day" | "time" | "place" | "done" | "category_id">>;

export const updateTodo = (id: string, changes: TodoChanges) =>
  call<TodoItem>(`/api/todo/items/${id}`, "PATCH", changes);

export const deleteTodo = (id: string) => call<void>(`/api/todo/items/${id}`, "DELETE");

export const reorderTodos = (day: string, categoryId: string, ids: string[]) =>
  call<void>("/api/todo/order", "PUT", { day, category_id: categoryId, ids });

export const fetchCategories = async (): Promise<TodoCategory[]> =>
  (await call<{ categories: TodoCategory[] }>("/api/todo/categories")).categories;

export const reorderCategories = async (ids: string[]): Promise<TodoCategory[]> =>
  (await call<{ categories: TodoCategory[] }>("/api/todo/categories/order", "PUT", { ids })).categories;

export const deleteCategory = (id: string) => call<void>(`/api/todo/categories/${id}`, "DELETE");

export const addCategory = (name: string, color: string) =>
  call<TodoCategory>("/api/todo/categories", "POST", { name, color });

export const updateCategory = (id: string, changes: Partial<Pick<TodoCategory, "name" | "color" | "closed">>) =>
  call<TodoCategory>(`/api/todo/categories/${id}`, "PATCH", changes);

/** 화면에 보여 줄 짧은 안내(서버 코드 → 문장) */
export function todoErrorText(error: unknown): string {
  const code = error instanceof ApiError ? error.code : "";
  const status = error instanceof ApiError ? error.status : 0;
  if (status === 429) return "너무 빨라요. 잠시 뒤 다시 해 주세요.";
  const words: Record<string, string> = {
    bad_title: "할 일은 1~100자로 써 주세요.",
    bad_name: "이름은 1~20자로 써 주세요.",
    duplicate_name: "같은 이름의 카테고리가 있어요.",
    too_many_items: "하루에 넣을 수 있는 할 일(200개)을 넘었어요.",
    too_many_categories: "카테고리는 50개까지예요.",
    category_closed: "끝낸 카테고리에는 넣을 수 없어요.",
    last_category: "열린 카테고리가 하나는 있어야 해요.",
    bad_time: "시각이 올바르지 않아요.",
    bad_day: "날짜가 올바르지 않아요.",
  };
  return words[code] ?? "저장하지 못했어요. 다시 해 주세요.";
}

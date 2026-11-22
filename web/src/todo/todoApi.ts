// 할 일 API(공개 전 기능, 허용된 계정만). 허용되지 않으면 서버가 모든 주소에 404를 준다
import { announceTodoChange } from "./todoSync";
import { ApiError } from "../api";

export interface TodoCategory {
  id: string;
  name: string;
  color: string;
  visibility: "public" | "friends" | "selected" | "private";
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
  repeat: TodoRepeat | null;
  /** 반응(T4). 내 하루 보기, 친구 하루 보기에서 온다 */
  reactions?: TodoReaction[];
}

export interface TodoReaction {
  /** 유니코드 이모지 또는 디스코드 이모지 코드 <a:이름:ID> */
  emoji: string;
  count: number;
  mine: boolean;
}

export type RepeatRule = "daily" | "weekdays" | "weekly" | "monthly";

export interface TodoRepeat {
  id: string;
  rule: RepeatRule;
  /** 매주: 고른 요일(일=0 … 토=6) */
  weekdays: number[];
  start_day: string;
  end_day: string | null;
  /** 한국 공휴일에는 빼기 */
  skip_holidays: boolean;
  series_id: string;
}

/** 반복 화면의 한 기간(이름, 카테고리, 시각, 장소, 메모 포함) */
export interface RepeatPeriod extends TodoRepeat {
  category_id: string;
  title: string;
  memo: string;
  time: string | null;
  place: string | null;
}

/** 반복 하나(여러 기간). 기간이 모두 끝났으면 ended */
export interface RepeatSeries {
  id: string;
  current: RepeatPeriod;
  periods: { id: string; start_day: string; end_day: string | null }[];
  ended: boolean;
}

export interface NewRepeat {
  title: string;
  category_id: string;
  rule: RepeatRule;
  weekdays?: number[];
  start_day: string;
  end_day?: string | null;
  skip_holidays: boolean;
  time?: string | null;
  place?: string | null;
  memo?: string;
  /** 끝난 반복에 새 기간 더하기 */
  series_id?: string;
}

export const fetchRepeats = (today: string) =>
  call<{ series: RepeatSeries[] }>(`/api/todo/repeats?today=${encodeURIComponent(today)}`);
export const newRepeat = (input: NewRepeat) => call<RepeatPeriod>("/api/todo/repeats/new", "POST", input);
export const deleteRepeatSeries = (id: string) => call<void>(`/api/todo/repeats/series/${id}`, "DELETE");

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
  if (method !== "GET" && path.startsWith("/api/todo/")) announceTodoChange(); // 다른 창도 다시 받게
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
  call<TodoItem>(`/api/todo/items/${encodeURIComponent(id)}`, "PATCH", changes);

export const deleteTodo = (id: string, scope: "today" | "future" = "today") =>
  call<void>(`/api/todo/items/${encodeURIComponent(id)}?scope=${scope}`, "DELETE");

export interface RepeatInput {
  rule: RepeatRule;
  weekdays?: number[];
  end_day?: string | null;
  start_day?: string;
  skip_holidays?: boolean;
}

export const createRepeat = (itemId: string, input: RepeatInput) =>
  call<TodoRepeat>("/api/todo/repeats", "POST", { item_id: itemId, ...input });

export const updateRepeat = (id: string, changes: Partial<RepeatInput> & Partial<Pick<TodoItem, "title" | "memo" | "time" | "place" | "category_id">>) =>
  call<TodoRepeat>(`/api/todo/repeats/${id}`, "PATCH", changes);

export const stopRepeat = (id: string, day: string) => call<void>(`/api/todo/repeats/${id}/stop`, "POST", { day });

export const reorderTodos = (day: string, categoryId: string, ids: string[]) =>
  call<void>("/api/todo/order", "PUT", { day, category_id: categoryId, ids });

export const fetchCategories = () =>
  call<{ categories: TodoCategory[]; recent_colors: string[] }>("/api/todo/categories");

export const reorderCategories = async (ids: string[]): Promise<TodoCategory[]> =>
  (await call<{ categories: TodoCategory[] }>("/api/todo/categories/order", "PUT", { ids })).categories;

export const deleteCategory = (id: string) => call<void>(`/api/todo/categories/${id}`, "DELETE");

export const addCategory = (name: string, color: string) =>
  call<TodoCategory>("/api/todo/categories", "POST", { name, color });

export const updateCategory = (
  id: string,
  changes: Partial<Pick<TodoCategory, "name" | "color" | "closed" | "visibility" | "memo_shared">>,
) =>
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
    bad_place: "장소는 40자까지예요.",
    bad_memo: "메모는 1000자까지예요.",
    bad_weekdays: "요일을 하나 이상 골라 주세요.",
    bad_end_day: "끝나는 날은 시작한 날보다 뒤여야 해요.",
    too_many_repeats: "반복 할 일은 100개까지예요.",
    period_overlap: "새 기간은 앞 기간이 끝난 다음 날부터 시작해야 해요.",
    bad_alert_lead: "알림 시각을 다시 골라 주세요.",
    bad_tz: "이 기기의 시간대를 알 수 없어요.",
    bad_morning_via: "아침 요약 방법을 다시 골라 주세요.",
    bad_boss_mode: "위장 중 알림을 다시 골라 주세요.",
    bad_emoji: "이 이모지는 쓸 수 없어요.",
    too_many_reactions: "한 할 일에 반응은 10개까지예요.",
    too_many_requests: "보낸 친구 요청이 너무 많아요(20개).",
    too_many_friends: "친구는 200명까지예요.",
    too_many_groups: "그룹은 30개까지예요.",
    not_friend: "친구만 고를 수 있어요.",
  };
  return words[code] ?? "저장하지 못했어요. 다시 해 주세요.";
}

// ------------------------------------------------------------ 알림 설정(NOTI-01, NOTI-03)

export type AlertLead = 0 | 10 | 30 | 60;

export type MorningVia = "push" | "dm" | "both";

export type BossMode = "off" | "silent" | "full";

export interface TodoAlertPrefs {
  alert_lead: AlertLead | null;
  morning: string | null;
  tz: string;
  morning_via: MorningVia;
  /** 위장 화면일 때: off 안 띄움, silent 내용과 소리 없이, full 그대로 */
  boss_mode: BossMode;
}

export interface TodoNewsItem {
  id: string;
  kind: string;
  title: string;
  body: string;
  created_at: number;
}

export const fetchTodoNews = () => call<{ items: TodoNewsItem[]; unread: number }>("/api/todo/news");

export const markTodoNewsSeen = () => call<void>("/api/todo/news/seen", "POST");

/** 새 할 일 알림이 오면(탭) 소식 점과 '할 일' 줄을 다시 받게 알리는 이벤트 이름 */
export const TODO_NEWS_EVENT = "mos-todo-news";

export const fetchAlertPrefs = () => call<TodoAlertPrefs>("/api/todo/prefs");

export const saveAlertPrefs = (changes: Partial<TodoAlertPrefs>) => call<TodoAlertPrefs>("/api/todo/prefs", "PATCH", changes);

/** 이 브라우저의 시간대(서버가 알림 시각을 계산할 때 씀). 모르면 보내지 않는다 */
export function browserTz(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------ AI 연결(T3)

export interface TodoConnection {
  id: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

export const fetchConnectRequest = (id: string) =>
  call<{ client_name: string; redirect_host: string }>(`/api/todo/oauth/request/${encodeURIComponent(id)}`);

export const decideConnectRequest = (id: string, allow: boolean) =>
  call<{ redirect: string }>(`/api/todo/oauth/request/${encodeURIComponent(id)}`, "POST", { allow });

export const fetchConnections = () => call<{ connections: TodoConnection[]; mcp_url: string }>("/api/todo/connections");

export const disconnectAi = (id: string) => call<void>(`/api/todo/connections/${encodeURIComponent(id)}`, "DELETE");

export interface TodoAiPending {
  id: string;
  summary: string;
  created_at: number;
  client: string;
}

export interface TodoAiTrash {
  id: string;
  title: string;
  day: string;
  client: string;
  deleted_at: number;
}

export const fetchAiState = () => call<{ pending: TodoAiPending[]; trash: TodoAiTrash[] }>("/api/todo/ai");

export const decideAiPending = (id: string, approve: boolean) =>
  call<{ message: string }>(`/api/todo/ai/pending/${encodeURIComponent(id)}`, "POST", { approve });

export const restoreAiTrash = (id: string) => call<void>(`/api/todo/ai/trash/${encodeURIComponent(id)}/restore`, "POST");

// ------------------------------------------------------------ 친구(T4)

export interface TodoPerson {
  id: string;
  name: string;
  avatar_url: string | null;
}

export interface TodoPeople {
  friends: TodoPerson[];
  incoming: TodoPerson[];
  outgoing: TodoPerson[];
  candidates: TodoPerson[];
  accept_requests: boolean;
}

export interface FriendDay extends TodoDay {
  relation: "self" | "friend" | "server";
  person: TodoPerson | null;
}

export const fetchPeople = () => call<TodoPeople>("/api/todo/people");
export const requestFriend = (id: string) => call<{ state: string }>(`/api/todo/people/${encodeURIComponent(id)}/request`, "POST");
export const acceptFriend = (id: string) => call<{ state: string }>(`/api/todo/people/${encodeURIComponent(id)}/accept`, "POST");
export const removeFriend = (id: string) => call<void>(`/api/todo/people/${encodeURIComponent(id)}`, "DELETE");
export const setAcceptRequests = (value: boolean) => call<void>("/api/todo/people/settings", "PATCH", { accept_requests: value });
export const fetchFriendsToday = (day: string) =>
  call<{ friends: (TodoPerson & { done: number; total: number })[] }>(`/api/todo/friends/today?day=${day}`);
export const fetchFriendDay = (id: string, day: string) =>
  call<FriendDay>(`/api/todo/friends/${encodeURIComponent(id)}/day/${day}`);
export const reactTodo = (owner: string | null, item: string, emoji: string, on: boolean) =>
  call<{ reactions: TodoReaction[] }>("/api/todo/react", "POST", owner ? { owner, item, emoji, on } : { item, emoji, on });
export const fetchTodoEmojis = () =>
  call<{ emojis: { id: string; name: string; animated: boolean; group_id: string; group_name: string }[] }>("/api/todo/emojis");

// ------------------------------------------------------------ 친구 그룹, 일부 공개 대상

export interface TodoGroup {
  id: string;
  name: string;
  members: TodoPerson[];
}

export interface TodoAudience {
  friends: string[];
  groups: string[];
}

export const fetchGroups = async () => (await call<{ groups: TodoGroup[] }>("/api/todo/groups")).groups;
export const createGroup = (name: string, members: string[]) => call<TodoGroup>("/api/todo/groups", "POST", { name, members });
export const updateGroup = (id: string, changes: { name?: string; members?: string[] }) =>
  call<void>(`/api/todo/groups/${encodeURIComponent(id)}`, "PATCH", changes);
export const deleteGroup = (id: string) => call<void>(`/api/todo/groups/${encodeURIComponent(id)}`, "DELETE");
export const fetchAudience = (categoryId: string) =>
  call<TodoAudience>(`/api/todo/categories/${encodeURIComponent(categoryId)}/audience`);
export const saveAudience = (categoryId: string, audience: TodoAudience) =>
  call<TodoAudience>(`/api/todo/categories/${encodeURIComponent(categoryId)}/audience`, "PUT", audience);

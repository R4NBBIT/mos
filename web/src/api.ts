import type {
  ChannelInfo,
  GroupChannels,
  GroupList,
  Message,
  MessagePage,
  Reaction,
  SessionState,
  ThreadPage,
} from "./types";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    /** 서버가 주는 짧은 구분 문자열(예: "wrong_password") */
    public readonly code: string = "",
    public readonly retryAfter: number | null = null,
  ) {
    super(`HTTP ${status}${code ? ` ${code}` : ""}`);
  }
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  // 같은 출처 요청만 하고, 쿠키(HttpOnly)는 브라우저가 알아서 싣는다
  const response = await fetch(path, { credentials: "same-origin", ...init });
  if (!response.ok) {
    let code = "";
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (typeof body.detail === "string") code = body.detail;
    } catch {
      // 본문이 JSON이 아니면 상태 코드만
    }
    const retry = Number(response.headers.get("Retry-After"));
    throw new ApiError(response.status, code, Number.isFinite(retry) && retry > 0 ? retry : null);
  }
  return response;
}

function postJson(path: string, body?: unknown): Promise<Response> {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** 계정 연결(새 계정 추가·비밀번호 재설정)은 페이지 이동으로 시작한다 */
export function startConnect(purpose: "connect" | "add" | "reset" = "connect"): void {
  window.location.assign(`/api/auth/connect/start?purpose=${purpose}`);
}

export async function fetchSession(): Promise<SessionState> {
  return (await request("/api/session")).json() as Promise<SessionState>;
}

export async function setPassword(password: string): Promise<void> {
  await postJson("/api/auth/password", { password });
}

export async function unlock(accountId: string, password: string, keep: boolean): Promise<void> {
  await postJson("/api/session/unlock", { account_id: accountId, password, keep });
}

export async function lock(): Promise<void> {
  await postJson("/api/session/lock");
}

export async function switchAccount(accountId: string): Promise<void> {
  await postJson("/api/session/switch", { account_id: accountId });
}

export async function removeAccount(accountId: string): Promise<void> {
  await request(`/api/session/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" });
}

export async function fetchGroups(): Promise<GroupList> {
  return (await request("/api/groups")).json() as Promise<GroupList>;
}

export async function setPinned(kind: "group" | "channel", id: string, pinned: boolean): Promise<void> {
  if (pinned) {
    await postJson("/api/pins", { kind, id });
  } else {
    await request(`/api/pins/${kind}/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
}

export async function markRead(channelId: string, lastId: string): Promise<void> {
  await postJson(`/api/channels/${encodeURIComponent(channelId)}/read`, { last_id: lastId });
}

export async function fetchGroupChannels(groupId: string): Promise<GroupChannels> {
  return (await request(`/api/groups/${encodeURIComponent(groupId)}/channels`)).json() as Promise<GroupChannels>;
}

export async function fetchChannel(channelId: string): Promise<ChannelInfo> {
  return (await request(`/api/channels/${encodeURIComponent(channelId)}`)).json() as Promise<ChannelInfo>;
}

export async function fetchMessages(channelId: string, beforeId?: string): Promise<MessagePage> {
  const params = new URLSearchParams({ limit: "50" });
  if (beforeId) {
    params.set("before", beforeId);
  }
  const path = `/api/channels/${encodeURIComponent(channelId)}/messages?${params.toString()}`;
  return (await request(path)).json() as Promise<MessagePage>;
}

export async function sendMessage(
  channelId: string,
  content: string,
  nonce: string,
  replyTo: string | null,
): Promise<Message> {
  const body: Record<string, string> = { content, nonce };
  if (replyTo) body.reply_to = replyTo;
  const response = await postJson(`/api/channels/${encodeURIComponent(channelId)}/messages`, body);
  return response.json() as Promise<Message>;
}

export async function editMessage(messageId: string, content: string): Promise<Message> {
  const response = await request(`/api/messages/${encodeURIComponent(messageId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  return response.json() as Promise<Message>;
}

export async function toggleReaction(messageId: string, emoji: string): Promise<Reaction[]> {
  const response = await request(`/api/messages/${encodeURIComponent(messageId)}/reactions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ emoji }),
  });
  return ((await response.json()) as { reactions: Reaction[] }).reactions;
}

export async function deleteMessage(messageId: string): Promise<void> {
  await request(`/api/messages/${encodeURIComponent(messageId)}`, { method: "DELETE" });
}

export interface ChannelEmoji {
  id: string;
  name: string;
  animated: boolean;
  group_id: string;
  group_name: string;
}

export interface ChannelEmojis {
  premium: boolean;
  nitro: "none" | "pending" | "verified";
  emojis: ChannelEmoji[];
}

export async function fetchEmojis(channelId: string): Promise<ChannelEmojis> {
  return (await request(`/api/channels/${encodeURIComponent(channelId)}/emojis`)).json() as Promise<ChannelEmojis>;
}

export async function setNitroClaim(claimed: boolean): Promise<void> {
  await postJson("/api/account/nitro", { claimed });
}

export async function sendFiles(
  channelId: string,
  content: string,
  nonce: string,
  replyTo: string | null,
  files: File[],
): Promise<Message> {
  const form = new FormData();
  form.append("nonce", nonce);
  form.append("content", content);
  if (replyTo) form.append("reply_to", replyTo);
  for (const file of files) form.append("files", file, file.name);
  // Content-Type(경계 포함)은 브라우저가 정한다
  const response = await request(`/api/channels/${encodeURIComponent(channelId)}/messages/files`, {
    method: "POST",
    body: form,
  });
  return response.json() as Promise<Message>;
}

export async function fetchThreads(parentId: string, before: number | null): Promise<ThreadPage> {
  const query = before ? `?before=${encodeURIComponent(String(before))}` : "";
  return (await request(`/api/channels/${encodeURIComponent(parentId)}/threads${query}`)).json() as Promise<ThreadPage>;
}

export async function createPost(
  forumId: string,
  title: string,
  content: string,
  tagIds: string[],
  nonce: string,
  files: File[],
): Promise<{ thread_id: string }> {
  const form = new FormData();
  form.append("nonce", nonce);
  form.append("title", title);
  form.append("content", content);
  form.append("tag_ids", tagIds.join(","));
  for (const file of files) form.append("files", file, file.name);
  const response = await request(`/api/channels/${encodeURIComponent(forumId)}/posts`, {
    method: "POST",
    body: form,
  });
  return response.json() as Promise<{ thread_id: string }>;
}

export async function fetchSettings(): Promise<import("./theme").Settings> {
  return (await request("/api/settings")).json() as Promise<import("./theme").Settings>;
}

export async function updateSettings(
  changes: Partial<import("./theme").Settings>,
): Promise<import("./theme").Settings> {
  const response = await request("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(changes),
  });
  return response.json() as Promise<import("./theme").Settings>;
}

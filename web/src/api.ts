import type { ChannelInfo, Group, GroupChannels, MessagePage, SessionState } from "./types";

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

export async function fetchGroups(): Promise<Group[]> {
  const body = (await (await request("/api/groups")).json()) as { groups: Group[] };
  return body.groups;
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

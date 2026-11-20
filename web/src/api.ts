import type { ChannelInfo, MessagePage } from "./types";

export class ApiError extends Error {
  constructor(public readonly status: number) {
    super(`HTTP ${status}`);
  }
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  // 같은 출처 요청만 하고, 쿠키(HttpOnly)는 브라우저가 알아서 싣는다
  const response = await fetch(path, { credentials: "same-origin", ...init });
  if (!response.ok) {
    throw new ApiError(response.status);
  }
  return response;
}

export async function checkSession(): Promise<boolean> {
  try {
    await request("/api/preview/session");
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return false;
    }
    throw error;
  }
}

export async function login(key: string): Promise<void> {
  await request("/api/preview/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
}

export async function logout(): Promise<void> {
  await request("/api/preview/session", { method: "DELETE" });
}

export async function fetchChannel(): Promise<ChannelInfo> {
  return (await request("/api/preview/channel")).json() as Promise<ChannelInfo>;
}

export async function fetchMessages(channelId: string, beforeId?: string): Promise<MessagePage> {
  const params = new URLSearchParams({ limit: "50" });
  if (beforeId) {
    params.set("before", beforeId);
  }
  const path = `/api/channels/${encodeURIComponent(channelId)}/messages?${params.toString()}`;
  return (await request(path)).json() as Promise<MessagePage>;
}

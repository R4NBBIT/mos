// 위장 화면 파일과 고친 내용을 계정에 저장한다(다른 브라우저·PC에서도 그대로).
// 받은 파일은 이 브라우저에 버전별로 보관해(Cache API) 같은 파일을 다시 받지 않는다.
// 잠긴 상태로 새로 열어도 위장 화면은 떠야 하므로, 마지막 목록도 이 브라우저에 기억한다.
import { ApiError } from "../api";

export type AssetKind = "sheet" | "image" | "text";

export interface AssetInfo {
  name: string;
  mime: string;
  size: number;
  version: string;
}

export type AssetList = Partial<Record<AssetKind, AssetInfo>>;

const INFO_KEY = "mos.boss.info.v1";
const CACHE_NAME = "mos-boss-v1";

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  if (!response.ok) {
    let code = "";
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (typeof body.detail === "string") code = body.detail;
    } catch {
      // 본문이 JSON이 아니면 상태 코드만
    }
    throw new ApiError(response.status, code, null);
  }
  return response;
}

export function cachedInfo(): AssetList {
  try {
    const value = JSON.parse(window.localStorage.getItem(INFO_KEY) ?? "{}") as AssetList;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function rememberInfo(info: AssetList): void {
  try {
    window.localStorage.setItem(INFO_KEY, JSON.stringify(info));
  } catch {
    // 저장소를 못 쓰면 기억하지 않는다
  }
}

/** 계정에 저장된 위장 파일 목록(받으면 이 브라우저에도 기억) */
export async function fetchBossInfo(): Promise<AssetList> {
  const body = (await (await call("/api/boss")).json()) as { assets: AssetList };
  rememberInfo(body.assets);
  return body.assets;
}

function cacheKey(kind: AssetKind, version: string): string {
  return `/__boss/${kind}/${version}`;
}

async function openCache(): Promise<Cache | null> {
  try {
    return "caches" in window ? await caches.open(CACHE_NAME) : null;
  } catch {
    return null;
  }
}

/** 파일 내용. 이 브라우저에 같은 버전이 있으면 서버에 묻지 않는다(잠긴 상태에서도 열림) */
export async function loadAsset(kind: AssetKind, info: AssetInfo): Promise<Blob> {
  const cache = await openCache();
  const hit = await cache?.match(cacheKey(kind, info.version));
  if (hit) return hit.blob();
  const response = await call(`/api/boss/assets/${kind}`);
  const blob = await response.blob();
  const version = response.headers.get("X-Boss-Version") ?? info.version;
  if (cache) {
    for (const key of await cache.keys()) {
      if (new URL(key.url).pathname.startsWith(`/__boss/${kind}/`)) await cache.delete(key);
    }
    await cache.put(cacheKey(kind, version), new Response(blob, { headers: { "Content-Type": blob.type } }));
  }
  return blob;
}

export async function uploadAsset(kind: AssetKind, name: string, body: Blob | string): Promise<AssetInfo> {
  const response = await call(`/api/boss/assets/${kind}?name=${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body,
  });
  const info = (await response.json()) as AssetInfo;
  rememberInfo({ ...cachedInfo(), [kind]: info });
  return info;
}

export async function removeAsset(kind: AssetKind): Promise<void> {
  await call(`/api/boss/assets/${kind}`, { method: "DELETE" });
  const info = cachedInfo();
  delete info[kind];
  rememberInfo(info);
}

// ------------------------------------------------------------ 고친 내용(표에 고친 값, 글 문서 내용)

export function localEdits<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function saveLocal(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 꽉 차면 서버에만
  }
}

/** 서버에 있는 고친 내용(없으면 null). 서버가 기준이고, 이 브라우저 것은 바로 보이기 위한 사본 */
export async function pullEdits<T>(key: string): Promise<T | null> {
  const body = (await (await call(`/api/boss/edits/${encodeURIComponent(key)}`)).json()) as { edits: T | null };
  if (body.edits !== null) saveLocal(key, body.edits);
  return body.edits;
}

const pending = new Map<string, number>();

/** 이 브라우저에 바로 남기고, 서버에는 잠깐 모았다가(1.5초) 보낸다 */
export function pushEdits(key: string, value: unknown): void {
  saveLocal(key, value);
  window.clearTimeout(pending.get(key));
  pending.set(
    key,
    window.setTimeout(() => {
      pending.delete(key);
      void call(`/api/boss/edits/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      }).catch(() => {}); // 잠겼거나 끊겼으면 이 브라우저 사본만(다음에 고칠 때 다시 보냄)
    }, 1500),
  );
}

/** 처음 상태로 되돌리기 */
export async function resetEdits(key: string): Promise<void> {
  window.clearTimeout(pending.get(key));
  pending.delete(key);
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 무시
  }
  await call(`/api/boss/edits/${encodeURIComponent(key)}`, { method: "DELETE" });
}

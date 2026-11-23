const timeFormat = new Intl.DateTimeFormat("ko-KR", { hour: "numeric", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "long",
});

/** 말풍선 옆 시간: '오후 3:12' */
export function formatTime(iso: string): string {
  return timeFormat.format(new Date(iso));
}

/** 날짜 구분선: '2026년 11월 20일 금요일' */
export function formatDay(iso: string): string {
  return dayFormat.format(new Date(iso));
}

export function dayKey(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 디스코드 ID 비교(문자열 → BigInt) */
export function compareIds(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

// 서버가 준 그림, 동영상, 파일 주소는 봉인돼 있다(/api/media/t/...). 서버가 대신 받아 주고,
// 주소창, 방문 기록, 회사 보안 장비 어디에도 디스코드 주소가 글자로 남지 않는다
const MEDIA_PREFIX = "/api/media/";

function addQuery(url: string, query: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}${query}`;
}

/** 그림, 파일 주소(서버를 거치는 주소만. download면 내려받기로). 그 밖의 주소는 쓰지 않는다 */
export function viaServer(url: string, download = false): string {
  if (!url.startsWith(MEDIA_PREFIX)) return "";
  return download ? addQuery(url, "dl=1") : url;
}

/** 작은 썸네일(서버가 디스코드에 줄인 그림을 받아 넘긴다) */
export function thumbnailUrl(proxyUrl: string, width: number): string {
  if (proxyUrl.startsWith(`${MEDIA_PREFIX}t/`)) return addQuery(proxyUrl, `w=${width}`);
  return viaServer(proxyUrl);
}

/** 서버 이모지 그림(ID만으로, 서버를 거쳐) */
export function emojiImageUrl(id: string, size: number, animated = false): string {
  return `${MEDIA_PREFIX}e/${encodeURIComponent(id)}?s=${size}${animated ? "&a=1" : ""}`;
}

/** 스티커 그림(ID와 형식만으로, 서버를 거쳐) */
export function stickerImageUrl(id: string, gif: boolean): string {
  return `${MEDIA_PREFIX}s/${encodeURIComponent(id)}.${gif ? "gif" : "png"}`;
}

/** 그림으로 띄워도 되는 주소: 서버를 거치는 주소만(디스코드 주소는 화면에 오지 않는다) */
export function isDiscordMediaUrl(value: string | null | undefined): value is string {
  return Boolean(value?.startsWith(MEDIA_PREFIX));
}

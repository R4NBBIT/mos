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

/** 디스코드가 주는 media 프록시 주소에 크기를 붙여 작은 썸네일로 받는다(검증 완료) */
export function thumbnailUrl(proxyUrl: string, width: number): string {
  try {
    const url = new URL(proxyUrl);
    url.searchParams.set("width", String(width));
    url.searchParams.set("format", "webp");
    return url.toString();
  } catch {
    return proxyUrl;
  }
}

/** 디스코드 CDN·media 주소만 허용(다른 주소는 표시하지 않음) */
export function isDiscordMediaUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "cdn.discordapp.com" || url.hostname === "media.discordapp.net")
    );
  } catch {
    return false;
  }
}

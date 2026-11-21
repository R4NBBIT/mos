// 테마 적용: <html data-theme>, 탭 제목, 파비콘. 화면명세서 SCR-10·T-01
// 화면 어디에도 원래 서비스 이름이 드러나지 않게, 테마마다 평범한 문서처럼 보이는 제목·아이콘을 쓴다.
import { isDisguised } from "./boss/bossState";

export type Theme = "moon" | "night" | "sheet" | "memo" | "note";

export type BossTemplate = "weekly" | "sales" | "schedule" | "budget" | "myfile" | "image" | "text" | "url";

export interface Settings {
  theme: Theme;
  tab_title: string | null;
  /** 위장 화면 템플릿, 자동 위장, 돌아올 때 잠그기 */
  boss_template: BossTemplate;
  boss_auto: boolean;
  boss_relock: boolean;
  /** 보스키(boss/bossKey.ts 모양) */
  boss_key: string;
  /** 사진 위장: cover 꽉 채우기(가장자리 잘림), contain 다 보이게 */
  boss_fit: "cover" | "contain";
  /** 위장할 때 전체 화면으로(주소창·탭까지 가림) */
  boss_fullscreen: boolean;
  /** 다른 사이트로 이동 위장의 주소(https만) */
  boss_url: string | null;
  /** 알림(기본 켬): 범위는 나를 부른 것만 / 나를 부른 것 + 고정한 채널, 내용 보이기는 기본 끔 */
  notify: boolean;
  notify_scope: NotifyScope;
  notify_preview: boolean;
  /** 처음 사용 안내를 봤는지 */
  guide_done: boolean;
  /** 아무것도 안 하면 잠기는 시간(분) */
  lock_minutes: number;
}

export const LOCK_MINUTES = [5, 10, 15, 30, 60, 120, 240, 480];

export function lockLabel(minutes: number): string {
  return minutes >= 60 ? `${minutes / 60}시간` : `${minutes}분`;
}

export type NotifyScope = "mentions" | "pinned";

const BOSS_TEMPLATES: BossTemplate[] = ["weekly", "sales", "schedule", "budget", "myfile", "image", "text", "url"];

export const DEFAULT_SETTINGS: Settings = {
  theme: "moon",
  tab_title: null,
  boss_template: "weekly",
  boss_auto: false,
  boss_relock: false,
  boss_key: "Escape*2",
  boss_fit: "cover",
  boss_fullscreen: false,
  boss_url: null,
  notify: true,
  notify_scope: "pinned",
  notify_preview: false,
  guide_done: false,
  lock_minutes: 30,
};

const BOSS_KEY_RE = /^(?:(?:Ctrl|Alt|Shift|Meta)\+){0,4}[A-Za-z][A-Za-z0-9]{0,24}(?:\*2)?$/;

export const THEMES: { id: Theme; name: string }[] = [
  { id: "moon", name: "기본" },
  { id: "night", name: "다크" },
  { id: "sheet", name: "스프레드시트" },
  { id: "memo", name: "메모장" },
  { id: "note", name: "노트" },
];

const DEFAULT_TITLES: Record<Theme, string> = {
  moon: "작업 메모",
  night: "작업 메모",
  sheet: "통합 문서1",
  memo: "제목 없음 - 메모장",
  note: "업무 노트",
};

const svg = (body: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${body}</svg>`)}`;

const FAVICONS: Record<Theme, string> = {
  moon: svg('<rect x="6" y="3" width="20" height="26" rx="3" fill="#f1f2f4" stroke="#62666d" stroke-width="2"/><path d="M11 11h10M11 16h10M11 21h6" stroke="#62666d" stroke-width="2"/>'),
  night: svg('<rect x="6" y="3" width="20" height="26" rx="3" fill="#1e2230" stroke="#a7a08f" stroke-width="2"/><path d="M11 11h10M11 16h10M11 21h6" stroke="#a7a08f" stroke-width="2"/>'),
  sheet: svg('<rect x="3" y="3" width="26" height="26" rx="3" fill="#1f6e43"/><path d="M8 10h16M8 16h16M8 22h16M14 7v18M20 7v18" stroke="#fff" stroke-width="1.6"/>'),
  memo: svg('<rect x="6" y="3" width="20" height="26" fill="#ffffff" stroke="#3b6fb6" stroke-width="2"/><path d="M10 10h12M10 15h12M10 20h8" stroke="#555" stroke-width="1.6"/>'),
  note: svg('<rect x="5" y="4" width="22" height="24" rx="4" fill="#ffffff" stroke="#37352f" stroke-width="2"/><path d="M10 11h12M10 16h12M10 21h7" stroke="#9b9a97" stroke-width="1.8" stroke-linecap="round"/>'),
};

const CACHE_KEY = "mos.look"; // 잠금 화면에서도 같은 제목·아이콘을 쓰려고 이 브라우저에 기억

export function defaultTitle(theme: Theme): string {
  return DEFAULT_TITLES[theme];
}

function setIcon(href: string): void {
  let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!icon) {
    icon = document.createElement("link");
    icon.rel = "icon";
    document.head.appendChild(icon);
  }
  icon.href = href;
}

// 탭 제목 앞에 붙는 알림 숫자. 위장 화면에서는 붙이지 않는다
let baseTitle = "";
let titleBadge = 0;

function showTitle(): void {
  if (isDisguised() || !baseTitle) return;
  document.title = titleBadge > 0 ? `(${titleBadge > 99 ? "99+" : titleBadge}) ${baseTitle}` : baseTitle;
}

export function setTitleBadge(count: number): void {
  titleBadge = Math.max(0, count);
  showTitle();
}

/** 지금 탭 아이콘(알림 창 아이콘으로 쓴다) */
export function currentIcon(): string {
  return document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href ?? "";
}

/** 지금 탭 제목(숫자 빼고) */
export function currentBaseTitle(): string {
  return baseTitle || document.title;
}

/** 위장 화면: 파일 이름을 탭 제목으로, 그 프로그램 아이콘(표는 시트, 글은 메모장) */
export function applyDisguise(fileName: string, icon: Theme = "sheet"): void {
  document.title = fileName;
  setIcon(FAVICONS[icon]);
}

export function applyLook(settings: Settings): void {
  const root = document.documentElement;
  if (settings.theme === "moon") delete root.dataset.theme;
  else root.dataset.theme = settings.theme;
  baseTitle = settings.tab_title || DEFAULT_TITLES[settings.theme];
  document.title = baseTitle;
  showTitle();
  setIcon(FAVICONS[settings.theme]);
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(settings));
  } catch {
    // 저장소를 못 쓰는 브라우저면 기억하지 않는다
  }
}

/** 잠금 화면 등 로그인 전: 이 브라우저에 기억해 둔 모양 */
export function cachedLook(): Settings {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (raw) {
      const value = JSON.parse(raw) as Partial<Settings>;
      if (value.theme && value.theme in DEFAULT_TITLES) {
        return {
          theme: value.theme,
          tab_title: typeof value.tab_title === "string" ? value.tab_title.slice(0, 40) : null,
          boss_template:
            value.boss_template && BOSS_TEMPLATES.includes(value.boss_template) ? value.boss_template : "weekly",
          boss_auto: value.boss_auto === true,
          boss_relock: value.boss_relock === true,
          boss_key:
            typeof value.boss_key === "string" && BOSS_KEY_RE.test(value.boss_key) ? value.boss_key : "Escape*2",
          boss_fit: value.boss_fit === "contain" ? "contain" : "cover",
          boss_fullscreen: value.boss_fullscreen === true,
          boss_url: typeof value.boss_url === "string" && /^https:\/\/\S+$/.test(value.boss_url) ? value.boss_url : null,
          notify: value.notify !== false,
          notify_scope: value.notify_scope === "mentions" ? "mentions" : "pinned",
          notify_preview: value.notify_preview === true,
          guide_done: value.guide_done === true,
          lock_minutes:
            typeof value.lock_minutes === "number" && LOCK_MINUTES.includes(value.lock_minutes) ? value.lock_minutes : 30,
        };
      }
    }
  } catch {
    // 무시
  }
  return { ...DEFAULT_SETTINGS };
}

/** 잠금·연결 화면 제목: 설정한 탭 제목, 없으면 테마 기본값 */
export function lookTitle(): string {
  const look = cachedLook();
  return look.tab_title || DEFAULT_TITLES[look.theme];
}

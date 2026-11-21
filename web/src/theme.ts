// 테마 적용: <html data-theme>, 탭 제목, 파비콘. 화면명세서 SCR-10·T-01
// 화면 어디에도 원래 서비스 이름이 드러나지 않게, 테마마다 평범한 문서처럼 보이는 제목·아이콘을 쓴다.

export type Theme = "moon" | "night" | "sheet" | "memo";

export type BossTemplate = "weekly" | "sales" | "schedule" | "budget" | "myfile";

export interface Settings {
  theme: Theme;
  tab_title: string | null;
  /** 위장 화면 템플릿, 자동 위장, 돌아올 때 잠그기 */
  boss_template: BossTemplate;
  boss_auto: boolean;
  boss_relock: boolean;
  /** 보스키(boss/bossKey.ts 모양) */
  boss_key: string;
}

const BOSS_TEMPLATES: BossTemplate[] = ["weekly", "sales", "schedule", "budget", "myfile"];

export const DEFAULT_SETTINGS: Settings = {
  theme: "moon",
  tab_title: null,
  boss_template: "weekly",
  boss_auto: false,
  boss_relock: false,
  boss_key: "Escape*2",
};

const BOSS_KEY_RE = /^(?:(?:Ctrl|Alt|Shift|Meta)\+){0,4}[A-Za-z][A-Za-z0-9]{0,24}(?:\*2)?$/;

export const THEMES: { id: Theme; name: string }[] = [
  { id: "moon", name: "기본" },
  { id: "night", name: "다크" },
  { id: "sheet", name: "스프레드시트" },
  { id: "memo", name: "메모장" },
];

const DEFAULT_TITLES: Record<Theme, string> = {
  moon: "작업 메모",
  night: "작업 메모",
  sheet: "통합 문서1",
  memo: "제목 없음 - 메모장",
};

const svg = (body: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${body}</svg>`)}`;

const FAVICONS: Record<Theme, string> = {
  moon: svg('<rect x="6" y="3" width="20" height="26" rx="3" fill="#f1f2f4" stroke="#62666d" stroke-width="2"/><path d="M11 11h10M11 16h10M11 21h6" stroke="#62666d" stroke-width="2"/>'),
  night: svg('<rect x="6" y="3" width="20" height="26" rx="3" fill="#1e2230" stroke="#a7a08f" stroke-width="2"/><path d="M11 11h10M11 16h10M11 21h6" stroke="#a7a08f" stroke-width="2"/>'),
  sheet: svg('<rect x="3" y="3" width="26" height="26" rx="3" fill="#1f6e43"/><path d="M8 10h16M8 16h16M8 22h16M14 7v18M20 7v18" stroke="#fff" stroke-width="1.6"/>'),
  memo: svg('<rect x="6" y="3" width="20" height="26" fill="#ffffff" stroke="#3b6fb6" stroke-width="2"/><path d="M10 10h12M10 15h12M10 20h8" stroke="#555" stroke-width="1.6"/>'),
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

/** 위장 화면: 파일 이름을 탭 제목으로, 시트 아이콘 */
export function applyDisguise(fileName: string): void {
  document.title = fileName;
  setIcon(FAVICONS.sheet);
}

export function applyLook(settings: Settings): void {
  const root = document.documentElement;
  if (settings.theme === "moon") delete root.dataset.theme;
  else root.dataset.theme = settings.theme;
  document.title = settings.tab_title || DEFAULT_TITLES[settings.theme];
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

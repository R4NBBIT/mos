// 홈 화면 앱(설치형 웹앱). 이름과 아이콘은 설치할 때 고르고, 이 브라우저에 기억해 둔다.
// 설치 정보(manifest)는 서버가 고른 값으로 만들어 주고(/api/app/manifest), 화면은 그 주소만 바꾼다.

/** 아이콘 그림을 바꾸면 서버(APP_ICON_VERSION)와 같이 올린다 */
export const APP_ICON_VERSION = "2";

export interface AppIcon {
  key: string;
  label: string;
}

export const APP_ICONS: AppIcon[] = [
  { key: "a", label: "업무 노트" },
  { key: "b", label: "메모" },
  { key: "c", label: "TODO" },
  { key: "d", label: "일정" },
  { key: "e", label: "문서함" },
  { key: "f", label: "업무 표" },
  { key: "g", label: "회의록" },
  { key: "h", label: "ㅁㅇㅅ" },
];

export const DEFAULT_APP_NAME = "ㅁㅇㅅ";
export const DEFAULT_APP_ICON = "h";
export const APP_NAME_MAX = 20;
const KEY = "mos.appInstall";

export interface AppChoice {
  name: string;
  icon: string;
}

export function cleanAppName(raw: string): string {
  const text = Array.from(raw)
    .filter((ch) => ch >= " " && ch !== "\u007f")
    .join("")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
  return Array.from(text).slice(0, APP_NAME_MAX).join("").trim();
}

export function readAppChoice(): AppChoice {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<AppChoice>;
    const icon = APP_ICONS.some((item) => item.key === value.icon) ? (value.icon as string) : DEFAULT_APP_ICON;
    const name = typeof value.name === "string" ? cleanAppName(value.name) : "";
    return { name: name || DEFAULT_APP_NAME, icon };
  } catch {
    return { name: DEFAULT_APP_NAME, icon: DEFAULT_APP_ICON };
  }
}

function setLink(rel: string, href: string): void {
  let link = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!link) {
    link = document.createElement("link");
    link.rel = rel;
    document.head.appendChild(link);
  }
  if (link.getAttribute("href") !== href) link.href = href;
}

function setMeta(name: string, content: string): void {
  let meta = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = name;
    document.head.appendChild(meta);
  }
  meta.content = content;
}

/** 설치 정보 주소, 아이폰 홈 화면 이름과 아이콘을 고른 값으로 */
export function applyAppChoice(choice: AppChoice = readAppChoice()): void {
  const params = new URLSearchParams({ name: choice.name, icon: choice.icon });
  setLink("manifest", `/api/app/manifest?${params.toString()}`);
  setLink("apple-touch-icon", `/app-icons/${choice.icon}-apple.png?v=${APP_ICON_VERSION}`);
  setMeta("apple-mobile-web-app-title", choice.name);
  setMeta("apple-mobile-web-app-capable", "yes");
  setMeta("mobile-web-app-capable", "yes");
}

export function saveAppChoice(choice: AppChoice): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(choice));
  } catch {
    // 기억 못 해도 지금 설치에는 쓴다
  }
  applyAppChoice(choice);
}

// ------------------------------------------------------------ 브라우저 설치 창

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPromptEvent | null = null;

/** 브라우저가 스스로 띄우는 설치 안내는 막고(회사에서 갑자기 뜨지 않게), 단추를 누를 때 쓴다 */
export function watchInstallPrompt(): void {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferred = event as InstallPromptEvent;
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
  });
}

export function canPromptInstall(): boolean {
  return deferred !== null;
}

/** 고른 이름과 아이콘을 적용한 뒤 브라우저 설치 창. 결과: 설치함, 취소, 못 띄움 */
export async function promptInstall(choice: AppChoice): Promise<"accepted" | "dismissed" | "unavailable"> {
  const event = deferred;
  if (!event) return "unavailable";
  saveAppChoice(choice);
  // 바뀐 설치 정보를 브라우저가 다시 읽을 시간
  await new Promise((resolve) => window.setTimeout(resolve, 600));
  try {
    await event.prompt();
    const { outcome } = await event.userChoice;
    if (outcome === "accepted") deferred = null;
    return outcome;
  } catch {
    return "unavailable";
  }
}

// ------------------------------------------------------------ 기기, 브라우저 알아보기

export type Platform = "ios" | "android" | "desktop";

export function platform(): Platform {
  const agent = navigator.userAgent;
  // 아이패드는 컴퓨터 사파리처럼 보이기도 해서 손가락 입력으로 한 번 더 본다
  if (/iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1)) return "ios";
  if (/Android/.test(agent)) return "android";
  return "desktop";
}

/** 지금 홈 화면 앱으로 열려 있는지 */
export function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
}

export interface InAppBrowser {
  name: string;
  kind: "kakao" | "line" | "other";
}

const IN_APP: [RegExp, string, InAppBrowser["kind"]][] = [
  [/KAKAOTALK/i, "카카오톡", "kakao"],
  [/\bLine\//, "라인", "line"],
  [/NAVER\(inapp|NAVER/i, "네이버", "other"],
  [/Instagram/i, "인스타그램", "other"],
  [/FBAN|FBAV|FB_IAB/i, "페이스북", "other"],
  [/BAND\//i, "밴드", "other"],
  [/Everytime/i, "에브리타임", "other"],
  [/DaumApps|DaumDevice/i, "다음", "other"],
  [/Twitter/i, "엑스(트위터)", "other"],
  [/; wv\)/, "앱", "other"], // 안드로이드 앱 안 화면(WebView)
];

/** 카카오톡 같은 앱 안의 브라우저면 그 이름(여기서는 설치가 안 된다) */
export function inAppBrowser(): InAppBrowser | null {
  const agent = navigator.userAgent;
  for (const [pattern, name, kind] of IN_APP) {
    if (pattern.test(agent)) return { name, kind };
  }
  return null;
}

/** 바깥 브라우저(크롬, 사파리)로 여는 주소. 아이폰의 카카오톡, 라인 말고 다른 앱은 방법이 없어 null */
export function externalOpenUrl(app: InAppBrowser, url: string = window.location.href): string | null {
  if (app.kind === "kakao") return `kakaotalk://web/openExternal?url=${encodeURIComponent(url)}`;
  if (app.kind === "line") {
    const next = new URL(url);
    next.searchParams.set("openExternalBrowser", "1");
    return next.toString();
  }
  if (platform() === "android") {
    const next = new URL(url);
    return `intent://${next.host}${next.pathname}${next.search}${next.hash}#Intent;scheme=https;package=com.android.chrome;end`;
  }
  return null;
}

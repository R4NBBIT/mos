// 보스키: 사람마다 원하는 키로. 저장 모양은 "보조키+키 위치 이름(KeyboardEvent.code)", 두 번이면 "*2".
// 예: "Escape*2", "Ctrl+Shift+KeyK", "F8". 키 위치 이름을 쓰면 한글 입력 중에도 같은 키로 알아본다.

export const DEFAULT_BOSS_KEY = "Escape*2";
export const DOUBLE_PRESS_MS = 450;

const MODIFIERS = ["Ctrl", "Alt", "Shift", "Meta"] as const;
type Modifier = (typeof MODIFIERS)[number];

export interface BossKey {
  mods: Set<Modifier>;
  code: string;
  double: boolean;
}

export const IS_MAC = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "OSLeft",
  "OSRight",
  "CapsLock",
  "Fn",
]);

export function parseBossKey(text: string): BossKey {
  const double = text.endsWith("*2");
  const parts = (double ? text.slice(0, -2) : text).split("+");
  const code = parts.pop() ?? "Escape";
  const mods = new Set(parts.filter((part): part is Modifier => (MODIFIERS as readonly string[]).includes(part)));
  return { mods, code, double };
}

export function formatBossKey(key: BossKey): string {
  const mods = MODIFIERS.filter((mod) => key.mods.has(mod));
  return `${[...mods, key.code].join("+")}${key.double ? "*2" : ""}`;
}

/** 누른 키 → 보스키 모양(보조키만 누른 것은 null) */
export function keyFromEvent(event: KeyboardEvent, double = false): BossKey | null {
  if (!event.code || MODIFIER_CODES.has(event.code)) return null;
  const mods = new Set<Modifier>();
  if (event.ctrlKey) mods.add("Ctrl");
  if (event.altKey) mods.add("Alt");
  if (event.shiftKey) mods.add("Shift");
  if (event.metaKey) mods.add("Meta");
  return { mods, code: event.code, double };
}

export function sameKey(a: BossKey, b: BossKey): boolean {
  return a.code === b.code && MODIFIERS.every((mod) => a.mods.has(mod) === b.mods.has(mod));
}

const CODE_NAMES: Record<string, string> = {
  Escape: "Esc",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Space: "Space",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Lang1: "한/영",
  Lang2: "한자",
  IntlBackslash: "\\",
};

export function codeName(code: string): string {
  if (CODE_NAMES[code]) return CODE_NAMES[code] ?? code;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad/.test(code)) return `숫자패드 ${code.slice(6)}`;
  return code;
}

/** 화면에 보일 이름: "Ctrl + Shift + K", "Esc 두 번" */
export function bossKeyLabel(key: BossKey): string {
  const mods = MODIFIERS.filter((mod) => key.mods.has(mod)).map((mod) =>
    mod === "Meta" ? (IS_MAC ? "Cmd" : "Win") : mod === "Alt" && IS_MAC ? "Option" : mod,
  );
  const name = [...mods, codeName(key.code)].join(" + ");
  return key.double ? `${name} 두 번` : name;
}

export interface KeyWarning {
  /** blocked: 아예 동작하지 않을 수 있음, caution: 권장하지 않음 */
  level: "blocked" | "caution";
  reason: string;
}

const PRINTABLE = /^(Key[A-Z]|Digit\d|Numpad\d|Space|Minus|Equal|Bracket(Left|Right)|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote|IntlBackslash|Numpad(Add|Subtract|Multiply|Divide|Decimal))$/;
const EDITING = new Set([
  "Enter",
  "NumpadEnter",
  "Tab",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "F2",
  "Insert",
]);

/** 고른 키가 왜 권장되지 않는지. 비어 있으면 괜찮은 키 */
export function warningsFor(key: BossKey): KeyWarning[] {
  const warnings: KeyWarning[] = [];
  const { mods, code } = key;
  const primary: Modifier = IS_MAC ? "Meta" : "Ctrl";
  const only = (...wanted: Modifier[]) =>
    MODIFIERS.every((mod) => mods.has(mod) === wanted.includes(mod));
  const letter = /^Key[A-Z]$/.test(code) ? code.slice(3) : "";
  const blocked = (reason: string) => warnings.push({ level: "blocked", reason });
  const caution = (reason: string) => warnings.push({ level: "caution", reason });

  // 1. 운영체제·브라우저가 먼저 가져가서 웹 화면에는 오지 않는 키
  if (!IS_MAC && mods.has("Meta")) {
    blocked("Windows 키 조합은 운영체제가 먼저 가져가서 웹 화면에 전달되지 않아요.");
  }
  if (only("Alt") && code === "F4") blocked("Alt + F4는 창을 닫는 키예요. 위장 화면으로 바뀌기 전에 브라우저가 꺼져요.");
  if ((only("Alt") || only("Alt", "Shift") || only("Meta") || only("Meta", "Shift")) && code === "Tab") {
    blocked("창 전환 키라서 운영체제가 먼저 가져가요.");
  }
  if (mods.has("Ctrl") && mods.has("Alt") && code === "Delete") blocked("운영체제 보안 화면 키라서 웹에서 받을 수 없어요.");
  if (IS_MAC && only("Meta") && ["KeyH", "KeyM", "KeyQ", "Space"].includes(code)) {
    blocked("Mac이 먼저 처리하는 키(가리기, 최소화, 종료, Spotlight)라서 웹 화면에 전달되지 않아요.");
  }
  if (
    (only(primary) && ["KeyW", "KeyT", "KeyN"].includes(code)) ||
    (only(primary, "Shift") && ["KeyW", "KeyT", "KeyN"].includes(code)) ||
    (only("Ctrl") && ["Tab", "PageUp", "PageDown"].includes(code)) ||
    (only("Ctrl", "Shift") && code === "Tab")
  ) {
    blocked("브라우저가 먼저 처리하는 키(탭 닫기, 새 탭, 새 창, 탭 이동)라서 웹에서 막을 수 없어요. 누르면 탭이 닫히거나 바뀌어요.");
  }
  if (code === "Lang1" || code === "Lang2") blocked("한/영, 한자 키는 입력기가 먼저 가져가서 웹 화면에 제대로 전달되지 않아요.");

  // 2. 브라우저 기능 키: 대신 새로고침·인쇄 등이 실행될 수 있음
  const browserKeys: Record<string, string> = {
    F1: "도움말",
    F3: "찾기",
    F5: "새로고침",
    F6: "주소창 이동",
    F7: "커서 탐색",
    F10: "메뉴",
    F11: "전체 화면",
    F12: "개발자 도구",
  };
  const plainBrowser = mods.size === 0 || only("Shift") ? browserKeys[code] : undefined;
  const primaryBrowser: Record<string, string> = {
    KeyR: "새로고침",
    KeyL: "주소창 이동",
    KeyD: "즐겨찾기 추가",
    KeyF: "찾기",
    KeyG: "다음 찾기",
    KeyP: "인쇄",
    KeyS: "페이지 저장",
    KeyH: "방문 기록",
    KeyJ: "다운로드 목록",
    KeyO: "파일 열기",
    KeyU: "페이지 소스 보기",
    KeyK: "검색",
    KeyE: "검색",
    Equal: "확대",
    Minus: "축소",
    Digit0: "확대 초기화",
    NumpadAdd: "확대",
    NumpadSubtract: "축소",
  };
  const withPrimary = only(primary) ? primaryBrowser[code] : undefined;
  const shiftPrimary =
    only(primary, "Shift") && ["KeyI", "KeyJ", "KeyC", "KeyR", "KeyB", "KeyO", "Delete"].includes(code)
      ? "개발자 도구, 강력 새로고침, 즐겨찾기 같은 브라우저 기능"
      : undefined;
  const tabDigit = only(primary) && /^Digit[1-9]$/.test(code) ? "탭 이동" : undefined;
  const altNav =
    only("Alt") && ["ArrowLeft", "ArrowRight", "Home", "KeyD", "KeyF", "KeyE"].includes(code)
      ? "뒤로 가기, 앞으로 가기, 주소창, 브라우저 메뉴"
      : undefined;
  const editKey =
    only(primary) && ["KeyA", "KeyC", "KeyV", "KeyX", "KeyZ", "KeyY"].includes(code)
      ? `${letter === "A" ? "전체 선택" : letter === "C" ? "복사" : letter === "V" ? "붙여넣기" : letter === "X" ? "잘라내기" : "되돌리기"}`
      : undefined;
  const feature = plainBrowser ?? withPrimary ?? shiftPrimary ?? tabDigit ?? altNav;
  if (feature && !warnings.some((warning) => warning.level === "blocked")) {
    caution(
      `브라우저 기능 키(${feature})예요. 주소창 등 웹 화면 밖에 커서가 있을 때 누르면 위장 화면 대신 '${feature}' 기능이 실행될 수 있어요.`,
    );
  }
  if (editKey) caution(`평소에 자주 쓰는 편집 키(${editKey})라서 복사, 붙여넣기를 하다가 화면이 바뀔 수 있어요.`);

  // 3. 글을 쓰다가 실수로 눌리기 쉬운 키
  const noCommand = !mods.has("Ctrl") && !mods.has("Alt") && !mods.has("Meta");
  if (noCommand && PRINTABLE.test(code)) {
    caution(
      key.double
        ? "글자 키라서 채팅을 치다가 'ㅋㅋ'처럼 같은 글자를 연달아 누르면 화면이 바뀌어요."
        : "글자 키라서 채팅을 치다가 한 번만 눌러도 화면이 바뀌어요.",
    );
  }
  if (noCommand && EDITING.has(code)) {
    caution("글쓰기와 위장 표 조작(셀 이동, 입력, 지우기)에 쓰는 키라서 실수로 바뀌기 쉬워요.");
  }
  if (mods.size === 0 && code === "Escape" && !key.double) {
    caution("메뉴를 닫거나 입력을 취소할 때도 쓰는 키라서 한 번만 누르는 건 실수로 바뀌기 쉬워요. '두 번'을 권해요.");
  }
  return warnings;
}

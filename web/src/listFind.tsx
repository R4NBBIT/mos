// 왼쪽 목록 찾기와 숨기기.
// 숨긴 서버, 채널은 계정 설정 hidden에 저장돼서 다른 브라우저에서도 같다(디스코드에는 그대로).
// 숨긴 것은 목록 맨 아래 '숨긴 항목' 묶음에 접혀 있고, 찾기에는 그대로 나온다.
import { type ReactNode, useState } from "react";
import { Collapse } from "./motion";
import { useLook } from "./lookContext";
import type { HiddenNotify } from "./theme";

const CHOSEONG = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const HANGUL_START = 0xac00;
const HANGUL_END = 0xd7a3;
const SYLLABLES_PER_INITIAL = 588;
const MAX_QUERY = 40;

/** 한글 글자는 첫소리로(ㄱ, ㄴ…), 나머지는 그대로 */
function initials(text: string): string {
  let result = "";
  for (const letter of text) {
    const code = letter.charCodeAt(0);
    result +=
      code >= HANGUL_START && code <= HANGUL_END
        ? CHOSEONG[Math.floor((code - HANGUL_START) / SYLLABLES_PER_INITIAL)]
        : letter;
  }
  return result;
}

function squash(text: string): string {
  return text.normalize("NFC").toLocaleLowerCase("ko").replace(/\s+/g, "");
}

/** 이름에 찾는 말이 들어 있는지. 띄어쓰기, 대소문자 무시, 'ㅈㄷ'처럼 첫소리로도 찾는다 */
export function nameMatches(name: string, query: string): boolean {
  const wanted = squash(query);
  if (!wanted) return true;
  const plain = squash(name);
  if (plain.includes(wanted)) return true;
  return /^[ㄱ-ㅎ]+$/.test(wanted) && initials(plain).includes(wanted);
}

/** 숨긴 서버, 채널 */
export function useHidden() {
  const { settings, save } = useLook();
  const hidden = new Set(settings.hidden);
  return {
    isHidden: (id: string) => hidden.has(id),
    setHidden: (id: string, hide: boolean) => {
      const rest = settings.hidden.filter((item) => item !== id);
      return save({ hidden: hide ? [...rest, id] : rest });
    },
    mode: settings.hidden_notify,
  };
}

/** 숨긴 채널이 묶음 배지에 더하는 수(서버 목록의 서버 합계와 같은 규칙) */
export function hiddenCounts(unread: number, mentions: number, mode: HiddenNotify): [number, number] {
  if (mode === "all") return [unread, mentions];
  if (mode === "mentions") return [mentions, mentions];
  return [0, 0];
}

/** 목록 편집 중 줄 끝: 숨기기, 다시 보이기 */
export function HideButton({ hidden, name, onToggle }: { hidden: boolean; name: string; onToggle: () => void }) {
  const label = hidden ? `${name} 다시 보이기` : `${name} 목록에서 숨기기`;
  return (
    <button
      type="button"
      className={hidden ? "hide-button hide-on" : "hide-button"}
      aria-pressed={hidden}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {hidden ? "보이기" : "숨기기"}
    </button>
  );
}

/** 목록 맨 아래 '숨긴 항목 n' 묶음(처음엔 접힘) */
export function HiddenFolder({
  count,
  badge,
  tree = false,
  children,
}: {
  count: number;
  badge?: ReactNode;
  /** 노션 트리 안(서버 아래 페이지 높이에 맞춰 들여 씀) */
  tree?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (count === 0) return null;
  return (
    <section className={tree ? "list-section hidden-folder hidden-folder-tree" : "list-section hidden-folder"}>
      <div
        className="list-item hidden-folder-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") setOpen((value) => !value);
        }}
      >
        <span className="tree-chevron" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className="list-name">
          숨긴 항목<span className="tree-others-count">{count}</span>
        </span>
        {!open && badge}
      </div>
      <Collapse open={open}>
        <div className="hidden-folder-list">{children}</div>
      </Collapse>
    </section>
  );
}

/** 목록 위 찾기 칸. Esc로 비운다 */
export function ListSearch({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="list-search" role="search">
      <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
        <circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="m15 15 5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        value={value}
        maxLength={MAX_QUERY}
        placeholder={placeholder}
        aria-label={placeholder}
        enterKeyHint="search"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.stopPropagation();
            onChange("");
          }
        }}
      />
      {value && (
        <button type="button" className="list-search-clear" aria-label="찾기 지우기" onClick={() => onChange("")}>
          ×
        </button>
      )}
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import {
  type BossKey,
  bossKeyLabel,
  codeName,
  DOUBLE_PRESS_MS,
  formatBossKey,
  IS_MAC,
  keyFromEvent,
  parseBossKey,
  sameKey,
  warningsFor,
} from "./boss/bossKey";
import { setCapturingKey } from "./boss/bossState";

// 보스키 바꾸기(SCR-10 4번). 키를 직접 눌러 정하거나 목록에서 고른다.
// 브라우저가 먼저 가져가는 키(Ctrl+W 등)는 눌러서는 잡을 수 없으니 목록으로도 고를 수 있게 하고, 권장하지 않는 이유를 보여 준다.

const KEY_CODES = [
  "Escape",
  "Backquote",
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
  ...Array.from({ length: 26 }, (_, index) => `Key${String.fromCharCode(65 + index)}`),
  ...Array.from({ length: 10 }, (_, index) => `Digit${index}`),
  "Space",
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Minus",
  "Equal",
  "BracketLeft",
  "BracketRight",
  "Backslash",
  "Semicolon",
  "Quote",
  "Comma",
  "Period",
  "Slash",
];

const MOD_LABELS: { mod: "Ctrl" | "Alt" | "Shift" | "Meta"; label: string }[] = [
  { mod: "Ctrl", label: "Ctrl" },
  { mod: "Alt", label: IS_MAC ? "Option" : "Alt" },
  { mod: "Shift", label: "Shift" },
  { mod: "Meta", label: IS_MAC ? "Cmd" : "Win" },
];

interface Props {
  value: string;
  onSave: (value: string) => void;
}

export default function BossKeyPicker({ value, onSave }: Props) {
  const current = useMemo(() => parseBossKey(value), [value]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<BossKey>(current);
  const [listening, setListening] = useState(false);

  useEffect(() => {
    if (!open) setDraft(current);
  }, [current, open]);

  // 키를 눌러서 정하기: 그동안은 보스키로 반응하지 않고, 같은 키를 빠르게 두 번 누르면 '두 번'으로
  useEffect(() => {
    if (!listening) return;
    setCapturingKey(true);
    let last: { key: BossKey; at: number } | null = null;
    const onKey = (event: KeyboardEvent) => {
      const key = keyFromEvent(event);
      if (!key) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      const now = Date.now();
      const twice = last !== null && sameKey(last.key, key) && now - last.at <= DOUBLE_PRESS_MS;
      last = { key, at: now };
      setDraft({ ...key, double: twice });
    };
    // Ctrl+W처럼 탭을 닫는 키를 누르면 브라우저가 한 번 물어보게
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("beforeunload", onLeave);
      setCapturingKey(false);
    };
  }, [listening]);

  const warnings = warningsFor(draft);
  const blocked = warnings.some((warning) => warning.level === "blocked");
  const changed = formatBossKey(draft) !== formatBossKey(current);

  if (!open) {
    return (
      <div className="settings-row boss-key-row">
        <span>보스키</span>
        <strong className="boss-key-current">{bossKeyLabel(current)}</strong>
        <button type="button" className="text-button" onClick={() => setOpen(true)}>
          바꾸기
        </button>
      </div>
    );
  }

  return (
    <div className="boss-key-panel">
      <div className="settings-row">
        <span>보스키</span>
        <strong className="boss-key-current">{bossKeyLabel(draft)}</strong>
      </div>
      <button
        type="button"
        className={listening ? "boss-key-listen boss-key-listening" : "boss-key-listen"}
        onClick={() => setListening((value) => !value)}
      >
        {listening
          ? "원하는 키를 눌러 주세요(같은 키를 빠르게 두 번 누르면 '두 번'). 다 됐으면 여기를 눌러요"
          : "키를 눌러서 정하기"}
      </button>
      <div className="boss-key-build" aria-label="목록에서 고르기">
        {MOD_LABELS.map(({ mod, label }) => (
          <label key={mod} className="settings-check boss-key-mod">
            <input
              type="checkbox"
              checked={draft.mods.has(mod)}
              onChange={(event) => {
                const mods = new Set(draft.mods);
                if (event.target.checked) mods.add(mod);
                else mods.delete(mod);
                setDraft({ ...draft, mods });
              }}
            />
            {label}
          </label>
        ))}
        <span>+</span>
        <select
          value={KEY_CODES.includes(draft.code) ? draft.code : ""}
          aria-label="키"
          onChange={(event) => setDraft({ ...draft, code: event.target.value })}
        >
          {!KEY_CODES.includes(draft.code) && <option value="">{codeName(draft.code)}</option>}
          {KEY_CODES.map((code) => (
            <option key={code} value={code}>
              {codeName(code)}
            </option>
          ))}
        </select>
        <label className="settings-check boss-key-mod">
          <input
            type="checkbox"
            checked={draft.double}
            onChange={(event) => setDraft({ ...draft, double: event.target.checked })}
          />
          빠르게 두 번
        </label>
      </div>

      {warnings.length > 0 ? (
        <ul className="boss-key-warnings">
          {warnings.map((warning) => (
            <li key={warning.reason} className={warning.level === "blocked" ? "boss-key-blocked" : "boss-key-caution"}>
              <strong>{warning.level === "blocked" ? "동작하지 않을 수 있어요" : "권장하지 않아요"}</strong>{" "}
              {warning.reason}
            </li>
          ))}
        </ul>
      ) : (
        <p className="settings-note boss-key-ok">괜찮은 키예요.</p>
      )}

      <div className="settings-buttons">
        <button
          type="button"
          className="text-button"
          disabled={!changed}
          onClick={() => {
            setListening(false);
            onSave(formatBossKey(draft));
            setOpen(false);
          }}
        >
          {warnings.length > 0 ? (blocked ? "그래도 저장(동작 안 할 수 있음)" : "그래도 저장") : "저장"}
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() => {
            setListening(false);
            setDraft(parseBossKey("Escape*2"));
          }}
        >
          기본값(Esc 두 번)
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() => {
            setListening(false);
            setDraft(current);
            setOpen(false);
          }}
        >
          취소
        </button>
      </div>
    </div>
  );
}

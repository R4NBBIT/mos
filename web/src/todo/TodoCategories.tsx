// 카테고리 관리(SCR-07): 순서 바꾸기, 만들기, 이름과 색 고치기, 끝내기, 지우기
// 오늘 화면 머리의 '카테고리' 단추로 들어온다(#/todo/categories)
import { type ReactNode, useEffect, useRef, useState } from "react";
import BackIcon from "../BackIcon";
import { Sortable } from "../listOrder";
import SplitToggle from "../SplitToggle";
import { useEnterKey } from "./enterKey";
import {
  addCategory,
  deleteCategory,
  fetchCategories,
  reorderCategories,
  type TodoCategory,
  todoErrorText,
  updateCategory,
} from "./todoApi";
import "./todo.css";

const PRESETS = ["#FFD66B", "#2563EB", "#7C5CDB", "#16A34A", "#C2410C", "#DB2777", "#0891B2"];
const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** #2e8, 2E8EAA 같은 입력 → #22EE88. 아니면 null */
function normalHex(raw: string): string | null {
  const match = HEX_RE.exec(raw.trim());
  if (!match?.[1]) return null;
  const body = match[1].length === 3 ? [...match[1]].map((ch) => ch + ch).join("") : match[1];
  return `#${body.toUpperCase()}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgbToHex(rgb: [number, number, number]): string {
  return `#${rgb.map((part) => part.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/** 기본 7색 + 팔레트(브라우저 색 고르기 창) + HEX, R G B 직접 입력 */
function ColorPicker({ value, recent, onChange }: { value: string; recent: string[]; onChange: (color: string) => void }) {
  const [hex, setHex] = useState(value);
  const [rgb, setRgb] = useState<string[]>(hexToRgb(value).map(String));
  useEffect(() => {
    setHex(value);
    setRgb(hexToRgb(value).map(String));
  }, [value]);
  const hexBad = normalHex(hex) === null;
  const rgbParsed = rgb.map((part) => (/^\d{1,3}$/.test(part.trim()) ? Number(part) : -1));
  const rgbBad = rgbParsed.some((part) => part < 0 || part > 255);
  const custom = !PRESETS.includes(value) && !recent.includes(value);
  return (
    <div className="todo-color">
      <div className="todo-color-presets" role="radiogroup" aria-label="기본 색">
        {PRESETS.map((color) => (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={value === color}
            aria-label={`색 ${color}`}
            className={value === color ? "todo-swatch todo-swatch-on" : "todo-swatch"}
            style={{ background: color }}
            onClick={() => onChange(color)}
          />
        ))}
        <label className={custom ? "todo-swatch todo-swatch-custom todo-swatch-on" : "todo-swatch todo-swatch-custom"}>
          <span className="todo-sr">팔레트에서 고르기</span>
          <input type="color" value={value.toLowerCase()} onChange={(event) => onChange(event.target.value.toUpperCase())} />
          {custom && <span className="todo-swatch-fill" style={{ background: value }} />}
        </label>
      </div>
      {recent.length > 0 && (
        <div className="todo-color-recent" role="radiogroup" aria-label="최근에 고른 색">
          <span className="todo-color-recent-label">최근</span>
          {recent.map((color) => (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={value === color}
              aria-label={`최근 색 ${color}`}
              className={value === color ? "todo-swatch todo-swatch-small todo-swatch-on" : "todo-swatch todo-swatch-small"}
              style={{ background: color }}
              onClick={() => onChange(color)}
            />
          ))}
        </div>
      )}
      <div className="todo-color-fields">
        <label className="todo-field todo-field-hex">
          HEX
          <input
            className={hexBad ? "todo-input-bad" : undefined}
            value={hex}
            maxLength={7}
            spellCheck={false}
            onChange={(event) => {
              setHex(event.target.value);
              const next = normalHex(event.target.value);
              if (next) onChange(next);
            }}
          />
        </label>
        {(["R", "G", "B"] as const).map((name, index) => (
          <label key={name} className="todo-field">
            {name}
            <input
              className={rgbParsed[index] === -1 || (rgbParsed[index] ?? 0) > 255 ? "todo-input-bad" : undefined}
              value={rgb[index] ?? ""}
              inputMode="numeric"
              maxLength={3}
              onChange={(event) => {
                const next = [...rgb];
                next[index] = event.target.value;
                setRgb(next);
                const parts = next.map((part) => (/^\d{1,3}$/.test(part.trim()) ? Number(part) : -1));
                if (parts.every((part) => part >= 0 && part <= 255)) {
                  onChange(rgbToHex(parts as [number, number, number]));
                }
              }}
            />
          </label>
        ))}
      </div>
      {(hexBad || rgbBad) && <p className="todo-error">HEX는 #2E8B57처럼, R G B는 0~255로 써 주세요.</p>}
    </div>
  );
}

const VISIBILITY = [
  { value: "private", label: "나만", help: "나만 볼 수 있어요." },
  { value: "friends", label: "친구", help: "친구가 볼 수 있어요(반응도 달 수 있어요)." },
  { value: "public", label: "전체", help: "같은 디스코드 서버의 할 일 사용자 모두가 볼 수 있어요." },
] as const;

function CategoryEditor({
  category,
  recent,
  onSaved,
  onDeleted,
  onClose,
}: {
  category: TodoCategory;
  recent: string[];
  onSaved: (category: TodoCategory) => void;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(category.name);
  const [color, setColor] = useState(category.color);
  const [visibility, setVisibility] = useState(category.visibility);
  const [memoShared, setMemoShared] = useState(category.memo_shared);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const nameRef = useRef(name);
  nameRef.current = name;
  const save = async () => {
    try {
      const changes: { name?: string; color?: string; visibility?: TodoCategory["visibility"]; memo_shared?: boolean } = {};
      if (nameRef.current.trim() !== category.name) changes.name = nameRef.current.trim();
      if (color !== category.color) changes.color = color;
      if (visibility !== category.visibility) changes.visibility = visibility;
      if (memoShared !== category.memo_shared) changes.memo_shared = memoShared;
      if (Object.keys(changes).length > 0) onSaved(await updateCategory(category.id, changes));
      onClose();
    } catch (failure) {
      setError(todoErrorText(failure));
    }
  };
  const enter = useEnterKey(() => void save());
  const run = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (failure) {
      setError(todoErrorText(failure));
    }
  };
  return (
    <div className="todo-cat-editor">
      <label className="todo-field todo-field-wide">
        이름
        <input value={name} maxLength={20} onChange={(event) => setName(event.target.value)} {...enter} />
      </label>
      <div className="todo-field todo-field-wide">
        색
        <ColorPicker value={color} recent={recent} onChange={setColor} />
      </div>
      <div className="todo-field todo-field-wide">
        누가 볼 수 있나요
        <div className="todo-segment" role="radiogroup" aria-label="공개 범위">
          {VISIBILITY.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={visibility === option.value}
              className={visibility === option.value ? "todo-segment-on" : undefined}
              onClick={() => setVisibility(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="todo-setting-help">{VISIBILITY.find((option) => option.value === visibility)?.help}</span>
        <label className={visibility === "private" ? "todo-switch todo-switch-off" : "todo-switch"}>
          <input
            type="checkbox"
            role="switch"
            disabled={visibility === "private"}
            checked={memoShared && visibility !== "private"}
            onChange={(event) => setMemoShared(event.target.checked)}
          />
          <span className="todo-switch-track" aria-hidden="true" />
          <span>메모도 보여 주기</span>
        </label>
      </div>
      {error && <p className="todo-error">{error}</p>}
      <div className="todo-edit-actions">
        <button type="button" className="todo-small-button todo-primary" onClick={() => void save()}>
          저장
        </button>
        <button type="button" className="todo-small-button" onClick={onClose}>
          닫기
        </button>
        <span className="todo-spacer" />
        <button
          type="button"
          className="todo-small-button"
          onClick={() => void run(async () => onSaved(await updateCategory(category.id, { closed: !category.closed })))}
        >
          {category.closed ? "다시 열기" : "끝내기"}
        </button>
        <button type="button" className="todo-small-button todo-danger-text" onClick={() => setConfirming(true)}>
          지우기
        </button>
      </div>
      {confirming && (
        <div className="todo-confirm" role="group" aria-label="카테고리 지우기 확인">
          <span>'{category.name}'과 안의 할 일을 모두 지울까요? 되돌릴 수 없어요.</span>
          <div className="todo-confirm-buttons">
            <button type="button" className="todo-small-button" onClick={() => setConfirming(false)}>
              취소
            </button>
            <button
              type="button"
              className="todo-small-button todo-danger"
              onClick={() =>
                void run(async () => {
                  await deleteCategory(category.id);
                  onDeleted();
                })
              }
            >
              지우기
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function NewCategory({ count, recent, onMade }: { count: number; recent: string[]; onMade: (category: TodoCategory) => void }) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(PRESETS[count % PRESETS.length] ?? "#FFD66B");
  const [error, setError] = useState("");
  const nameRef = useRef(name);
  nameRef.current = name;
  const make = async () => {
    const value = nameRef.current.trim();
    if (!value) return;
    try {
      onMade(await addCategory(value, color));
      setName("");
      setError("");
      setColor(PRESETS[(count + 1) % PRESETS.length] ?? "#FFD66B");
    } catch (failure) {
      setError(todoErrorText(failure));
    }
  };
  const enter = useEnterKey(() => void make());
  return (
    <section className="todo-cat-new" aria-label="새 카테고리">
      <h2 className="list-section-title">새 카테고리</h2>
      <label className="todo-field todo-field-wide">
        이름
        <input value={name} maxLength={20} placeholder="예: 업무" onChange={(event) => setName(event.target.value)} {...enter} />
      </label>
      <div className="todo-field todo-field-wide">
        색
        <ColorPicker value={color} recent={recent} onChange={setColor} />
      </div>
      {error && <p className="todo-error">{error}</p>}
      <button type="button" className="todo-small-button todo-primary" disabled={!name.trim()} onClick={() => void make()}>
        만들기
      </button>
    </section>
  );
}

export default function TodoCategories({
  showBack,
  onBack,
  menu,
  onChanged,
}: {
  showBack: boolean;
  onBack: () => void;
  menu: ReactNode;
  onChanged?: () => void;
}) {
  const [items, setItems] = useState<TodoCategory[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    fetchCategories()
      .then((data) => {
        setItems(data.categories);
        setRecent(data.recent_colors);
      })
      .catch(() => setFailed(true));
  }, []);
  // 직접 고른 색은 서버가 최근 색으로 기억한다(다시 받아 맞춘다)
  const refreshRecent = () =>
    void fetchCategories()
      .then((data) => setRecent(data.recent_colors))
      .catch(() => {});
  const changed = (next: TodoCategory[]) => {
    setItems(next);
    onChanged?.();
    refreshRecent();
  };
  const reorder = async (ids: string[]) => {
    if (!items) return;
    const before = items;
    setItems(ids.map((id) => before.find((item) => item.id === id)).filter((item): item is TodoCategory => Boolean(item)));
    try {
      changed(await reorderCategories(ids));
    } catch (failure) {
      setItems(before);
      setError(todoErrorText(failure));
    }
  };
  return (
    <div className="room todo-room">
      <header className="room-header">
        <SplitToggle />
        {showBack && (
          <button type="button" className="back-button" onClick={onBack} aria-label="할 일로">
            <BackIcon />
          </button>
        )}
        <div className="room-title">
          <strong>카테고리</strong>
          <span className="room-sub">{items ? `${items.length}개, 손잡이를 끌어 순서 바꾸기` : ""}</span>
        </div>
        {!showBack && (
          <div className="header-tools">
            <button type="button" className="header-tool" onClick={onBack}>
              <span className="header-tool-label todo-tool-always">할 일로</span>
            </button>
          </div>
        )}
        {menu}
      </header>
      <div className="todo-cat-body">
        {error && (
          <p className="todo-error" role="alert">
            {error}
          </p>
        )}
        {items === null && <p className="list-note">{failed ? "불러오지 못했어요." : "불러오는 중…"}</p>}
        {items && (
          <Sortable items={items} editing label={(item) => item.name} onReorder={(ids) => void reorder(ids)}>
            {(category, handle) => (
              <div className="todo-cat-item">
                <div className="todo-cat-line">
                  {handle}
                  <span className="todo-dot todo-dot-big" style={{ background: category.color }} />
                  <span className="todo-cat-name">{category.name}</span>
                  {category.closed && <span className="list-sub">끝냄</span>}
                  <button
                    type="button"
                    className="todo-small-button"
                    aria-expanded={open === category.id}
                    onClick={() => setOpen(open === category.id ? null : category.id)}
                  >
                    {open === category.id ? "닫기" : "고치기"}
                  </button>
                </div>
                {open === category.id && (
                  <CategoryEditor
                    category={category}
                    recent={recent}
                    onSaved={(saved) => changed(items.map((item) => (item.id === saved.id ? saved : item)))}
                    onDeleted={() => {
                      setOpen(null);
                      changed(items.filter((item) => item.id !== category.id));
                    }}
                    onClose={() => setOpen(null)}
                  />
                )}
              </div>
            )}
          </Sortable>
        )}
        {items && <NewCategory count={items.length} recent={recent} onMade={(made) => changed([...items, made])} />}
      </div>
    </div>
  );
}

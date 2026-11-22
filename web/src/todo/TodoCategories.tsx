// 카테고리 관리(SCR-07): 순서 바꾸기, 만들기(+), 이름과 색 수정, 끝내기(아래 '끝낸 카테고리'로), 삭제(휴지통 7일)
// 오늘 화면 머리의 '카테고리' 단추로 들어온다(#/todo/categories)
import { type ReactNode, useEffect, useRef, useState } from "react";
import BackIcon from "../BackIcon";
import { Sortable } from "../listOrder";
import { AiRequests } from "./TodoAi";
import { AudiencePicker } from "./TodoAudience";
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
  fetchAudience,
  saveAudience,
  type TodoAudience,
} from "./todoApi";
import "./todo.css";

// 기본 색(2026-11-22 사용자 요청: 더 예쁘고 다양하게). 밝은 색은 체크 글자가 검게 바뀐다
export const PRESETS = [
  "#F6C344",
  "#FF8A65",
  "#F2668B",
  "#C77DFF",
  "#7B8CFF",
  "#4F9DFF",
  "#2EC4B6",
  "#5BC97A",
  "#A3C93A",
  "#B08968",
  "#8D99AE",
  "#2F3A4A",
];
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

export const VISIBILITY = [
  { value: "private", label: "나만", help: "나만 볼 수 있어요." },
  { value: "selected", label: "일부", help: "고른 친구와 그룹만 볼 수 있어요." },
  { value: "friends", label: "친구", help: "친구가 볼 수 있어요." },
  { value: "public", label: "전체", help: "같은 디스코드 서버의 모두가 볼 수 있어요." },
] as const;

function sameAudience(a: TodoAudience, b: TodoAudience): boolean {
  const key = (value: TodoAudience) => `${[...value.friends].sort().join(",")}|${[...value.groups].sort().join(",")}`;
  return key(a) === key(b);
}

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
  const [audience, setAudience] = useState<TodoAudience>({ friends: [], groups: [] });
  const [loadedAudience, setLoadedAudience] = useState<TodoAudience | null>(null);
  useEffect(() => {
    fetchAudience(category.id)
      .then((value) => {
        setAudience(value);
        setLoadedAudience(value);
      })
      .catch(() => setLoadedAudience({ friends: [], groups: [] }));
  }, [category.id]);
  const [error, setError] = useState("");
  const [asking, setAsking] = useState<"delete" | "cancel" | null>(null);
  const nameRef = useRef(name);
  nameRef.current = name;
  const dirty =
    name.trim() !== category.name ||
    color !== category.color ||
    visibility !== category.visibility ||
    memoShared !== category.memo_shared ||
    (loadedAudience !== null && !sameAudience(audience, loadedAudience));
  const save = async () => {
    try {
      const changes: { name?: string; color?: string; visibility?: TodoCategory["visibility"]; memo_shared?: boolean } = {};
      if (nameRef.current.trim() !== category.name) changes.name = nameRef.current.trim();
      if (color !== category.color) changes.color = color;
      if (visibility !== category.visibility) changes.visibility = visibility;
      if (memoShared !== category.memo_shared) changes.memo_shared = memoShared;
      if (visibility === "selected" && loadedAudience) await saveAudience(category.id, audience);
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
  const cancel = () => (dirty ? setAsking("cancel") : onClose());
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
        <div className="todo-segment todo-segment-full" role="radiogroup" aria-label="공개 범위">
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
        <span className="todo-field-help">{VISIBILITY.find((option) => option.value === visibility)?.help}</span>
        {visibility === "selected" && <AudiencePicker value={audience} onChange={setAudience} />}
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
      {asking === null && (
        <div className="todo-cat-actions">
          <div className="todo-cat-actions-side">
            <button
              type="button"
              className="todo-text-button"
              onClick={() => void run(async () => onSaved(await updateCategory(category.id, { closed: !category.closed })))}
            >
              {category.closed ? "다시 열기" : "끝내기"}
            </button>
            <button type="button" className="todo-text-button todo-danger-text" onClick={() => setAsking("delete")}>
              삭제
            </button>
          </div>
          <div className="todo-cat-actions-main">
            <button type="button" className="todo-small-button" onClick={cancel}>
              취소
            </button>
            <button type="button" className="todo-small-button todo-primary" onClick={() => void save()}>
              저장
            </button>
          </div>
        </div>
      )}
      {asking === "cancel" && (
        <div className="todo-confirm" role="alertdialog" aria-label="취소 확인">
          <span>바꾼 내용이 저장되지 않아요. 취소할까요?</span>
          <div className="todo-confirm-buttons">
            <button type="button" className="todo-small-button" onClick={() => setAsking(null)}>
              계속 수정
            </button>
            <button type="button" className="todo-small-button todo-primary" onClick={onClose}>
              취소하기
            </button>
          </div>
        </div>
      )}
      {asking === "delete" && (
        <div className="todo-confirm" role="alertdialog" aria-label="카테고리 삭제 확인">
          <span>'{category.name}' 카테고리와 안의 할 일을 삭제할까요? 휴지통에서 7일 동안 되살릴 수 있어요.</span>
          <div className="todo-confirm-buttons">
            <button type="button" className="todo-small-button" onClick={() => setAsking(null)}>
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
              삭제
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 새 카테고리: 할 일처럼 '+'를 누르면 칸이 열린다 */
function NewCategory({ count, recent, onMade }: { count: number; recent: string[]; onMade: (category: TodoCategory) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState(PRESETS[count % PRESETS.length] ?? "#F6C344");
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
      setOpen(false);
      setColor(PRESETS[(count + 1) % PRESETS.length] ?? "#F6C344");
    } catch (failure) {
      setError(todoErrorText(failure));
    }
  };
  const enter = useEnterKey(() => void make());
  if (!open) {
    return (
      <button type="button" className="todo-cat-add" aria-label="새 카테고리" onClick={() => setOpen(true)}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    );
  }
  return (
    <section className="todo-cat-item todo-cat-new" aria-label="새 카테고리">
      <label className="todo-field todo-field-wide">
        이름
        <input autoFocus value={name} maxLength={20} onChange={(event) => setName(event.target.value)} {...enter} />
      </label>
      <div className="todo-field todo-field-wide">
        색
        <ColorPicker value={color} recent={recent} onChange={setColor} />
      </div>
      {error && <p className="todo-error">{error}</p>}
      <div className="todo-cat-actions">
        <span />
        <div className="todo-cat-actions-main">
          <button
            type="button"
            className="todo-small-button"
            onClick={() => {
              setOpen(false);
              setName("");
              setError("");
            }}
          >
            취소
          </button>
          <button type="button" className="todo-small-button todo-primary" disabled={!name.trim()} onClick={() => void make()}>
            만들기
          </button>
        </div>
      </div>
    </section>
  );
}

function CategoryRow({
  category,
  open,
  handle,
  onOpen,
  actions,
  children,
}: {
  category: TodoCategory;
  open: boolean;
  handle?: ReactNode;
  onOpen: () => void;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const scope = VISIBILITY.find((option) => option.value === category.visibility)?.label ?? "";
  return (
    <div className={category.closed ? "todo-cat-item todo-cat-closed" : "todo-cat-item"}>
      <div className="todo-cat-line">
        {handle}
        <span className="todo-dot todo-dot-big" style={{ background: category.color }} />
        <span className="todo-cat-name">{category.name}</span>
        <span className="todo-cat-scope">{scope}</span>
        {!open && actions}
        {!open && (
          <button type="button" className="todo-small-button" onClick={onOpen}>
            수정
          </button>
        )}
      </div>
      {children}
    </div>
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
  const [trashKey, setTrashKey] = useState(0);
  const load = () =>
    fetchCategories()
      .then((data) => {
        setItems(data.categories);
        setRecent(data.recent_colors);
      })
      .catch(() => setFailed(true));
  useEffect(() => {
    void load();
  }, []);
  const changed = (next: TodoCategory[]) => {
    setItems(next);
    onChanged?.();
    void fetchCategories()
      .then((data) => setRecent(data.recent_colors))
      .catch(() => {});
  };
  const openItems = items?.filter((item) => !item.closed) ?? [];
  const closedItems = items?.filter((item) => item.closed) ?? [];
  const reorder = async (ids: string[]) => {
    if (!items) return;
    const before = items;
    const order = [...ids, ...closedItems.map((item) => item.id)];
    setItems(order.map((id) => before.find((item) => item.id === id)).filter((item): item is TodoCategory => Boolean(item)));
    try {
      changed(await reorderCategories(order));
    } catch (failure) {
      setItems(before);
      setError(todoErrorText(failure));
    }
  };
  const editor = (category: TodoCategory) =>
    open === category.id && items ? (
      <CategoryEditor
        category={category}
        recent={recent}
        onSaved={(saved) => changed(items.map((item) => (item.id === saved.id ? saved : item)))}
        onDeleted={() => {
          setOpen(null);
          changed(items.filter((item) => item.id !== category.id));
          setTrashKey((value) => value + 1);
        }}
        onClose={() => setOpen(null)}
      />
    ) : null;
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
          <span className="room-sub">{items ? `${openItems.length}개, 손잡이를 끌어 순서 바꾸기` : ""}</span>
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
          <Sortable items={openItems} editing label={(item) => item.name} onReorder={(ids) => void reorder(ids)}>
            {(category, handle) => (
              <CategoryRow category={category} open={open === category.id} handle={handle} onOpen={() => setOpen(category.id)}>
                {editor(category)}
              </CategoryRow>
            )}
          </Sortable>
        )}
        {items && <NewCategory count={items.length} recent={recent} onMade={(made) => changed([...items, made])} />}
        {closedItems.length > 0 && (
          <section className="todo-cat-section" aria-label="끝낸 카테고리">
            <h2 className="todo-cat-section-title">끝낸 카테고리</h2>
            <p className="todo-field-help">할 일 화면에 안 보여요. 다시 열면 위 목록으로 올라가요.</p>
            {closedItems.map((category) => (
              <CategoryRow
                key={category.id}
                category={category}
                open={open === category.id}
                onOpen={() => setOpen(category.id)}
                actions={
                  <button
                    type="button"
                    className="todo-small-button"
                    onClick={() =>
                      void updateCategory(category.id, { closed: false })
                        .then((saved) => changed(items?.map((item) => (item.id === saved.id ? saved : item)) ?? []))
                        .catch((failure: unknown) => setError(todoErrorText(failure)))
                    }
                  >
                    다시 열기
                  </button>
                }
              >
                {editor(category)}
              </CategoryRow>
            ))}
          </section>
        )}
        <section className="todo-alerts todo-trash" key={trashKey}>
          <AiRequests
            onChanged={() => {
              onChanged?.();
              void load();
            }}
          />
        </section>
      </div>
    </div>
  );
}

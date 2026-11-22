// TODO 한 줄과 TODO 메뉴(SCR-03), 카테고리 묶음의 입력칸(날짜 알아보기, TODO-13~15)
import { type CSSProperties, Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { dateWithWeekday, longLabel, timeLabel, today, WEEKDAY_NAMES } from "./dates";
import { useEnterKey } from "./enterKey";
import { TodoReactions } from "./TodoReactions";
import { parseWhen } from "./parseWhen";
import {
  deleteTodo,
  fetchAudience,
  fetchGroups,
  fetchPeople,
  type TodoCategory,
  todoErrorText,
  type TodoItem,
  type TodoRepeat,
  updateRepeat,
  updateTodo,
} from "./todoApi";

export const CHECK_PATH = "M5 12.5l4.5 4.5L19 7.5";

function luminance(color: string): number {
  const value = Number.parseInt(color.slice(1), 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 255) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}

function needsRing(color: string): boolean {
  return luminance(color) > 0.6;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** 체크 원 색: 완료하면 카테고리 색으로 채우고, 체크 표시는 그 색에서 잘 보이는 색으로 */
export function checkStyle(color: string | undefined): CSSProperties | undefined {
  if (!color || !HEX_COLOR.test(color)) return undefined;
  return {
    "--cat": color,
    "--cat-ink": luminance(color) > 0.42 ? "#1d232b" : "#ffffff",
  } as CSSProperties;
}

export function CategoryDot({ color }: { color: string }) {
  // 테두리 색(borderColor)은 채운 색과 같게: Word 테마는 테두리를 그 색으로 그린다
  return (
    <span
      className={needsRing(color) ? "todo-dot todo-dot-ring" : "todo-dot"}
      style={{ background: color, borderColor: color }}
    />
  );
}

export function repeatLabel(repeat: TodoRepeat): string {
  if (repeat.rule === "daily") return "매일";
  if (repeat.rule === "weekdays") return "평일마다";
  if (repeat.rule === "weekends") return "주말마다";
  if (repeat.rule === "monthly") return "매달";
  return `매주 ${repeat.weekdays.map((day) => WEEKDAY_NAMES[day]).join(" ")}`;
}

/** 메모 글자: http, https 주소만 누를 수 있는 링크로(ㅁㅇㅅ 본문 링크 규칙과 같음) */
export function MemoText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"]+)/g);
  return (
    <p className="todo-memo">
      {parts.map((part, index) =>
        /^https?:\/\//.test(part) ? (
          <a key={index} href={part} target="_blank" rel="noopener noreferrer nofollow">
            {part}
          </a>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </p>
  );
}

// ------------------------------------------------------------ TODO 메뉴

/** 일정 변경: 누르면 달력이 뜨고, 고르면 그날로 바로 옮긴다 */
function MoveDate({ value, disabled, onPick }: { value: string; disabled: boolean; onPick: (day: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <span className="todo-pick">
      <button
        type="button"
        className="todo-link-button"
        disabled={disabled}
        onClick={() => {
          try {
            ref.current?.showPicker();
          } catch {
            ref.current?.focus();
          }
        }}
      >
        일정 변경
      </button>
      <input
        ref={ref}
        className="todo-pick-input"
        type="date"
        tabIndex={-1}
        aria-label="옮길 날짜"
        value={value}
        onChange={(event) => {
          if (event.target.value && event.target.value !== value) onPick(event.target.value);
        }}
      />
    </span>
  );
}

/** 이 카테고리의 메모를 누가 보는지(카테고리 공개 설정 그대로, 일부면 이름까지) */
/** 메모 칸 아래 한 줄: 누가 보는지(메모 칸 안은 비워 둔다, 2026-11-23 사용자 요청) */
export function memoAudienceLine(who: { short: string; detail: string }): string {
  return who.detail || who.short.replace(/^메모 \((.*)\)$/, "$1");
}

export function useMemoAudience(category: TodoCategory | undefined): { short: string; detail: string } {
  const [names, setNames] = useState<string | null>(null);
  const selected = Boolean(category && category.memo_shared && category.visibility === "selected");
  const categoryId = category?.id;
  useEffect(() => {
    setNames(null);
    if (!selected || !categoryId) return;
    let stopped = false;
    Promise.all([fetchAudience(categoryId), fetchPeople(), fetchGroups()])
      .then(([audience, people, groups]) => {
        if (stopped) return;
        const groupNames = groups.filter((group) => audience.groups.includes(group.id)).map((group) => `${group.name} 그룹`);
        const friendNames = people.friends.filter((person) => audience.friends.includes(person.id)).map((person) => person.name);
        const inGroups = new Set(
          groups.filter((group) => audience.groups.includes(group.id)).flatMap((group) => group.members.map((m) => m.name)),
        );
        const all = [...groupNames, ...friendNames];
        const members = [...new Set([...inGroups, ...friendNames])];
        setNames(all.length ? `${all.join(", ")}${members.length ? `(모두 ${members.length}명)` : ""}` : "아무도 고르지 않았어요");
      })
      .catch(() => !stopped && setNames(""));
    return () => {
      stopped = true;
    };
  }, [selected, categoryId]);
  if (!category || !category.memo_shared || category.visibility === "private") {
    return { short: "메모 (나만 보여요)", detail: "" };
  }
  if (category.visibility === "friends") return { short: "메모 (친구에게도 보여요)", detail: "" };
  if (category.visibility === "public") return { short: "메모 (같은 디스코드 서버의 모두에게 보여요)", detail: "" };
  return {
    short: "메모 (고른 사람에게도 보여요)",
    detail: names === null ? "볼 수 있는 사람을 불러오는 중…" : names ? `이 메모를 볼 수 있는 사람: ${names}` : "",
  };
}


/** 날짜, 시각 고르기: 글자(요일 포함)를 누르면 브라우저 고르기 창이 바로 열린다 */
export function PickField({
  type,
  value,
  label,
  empty,
  min,
  required,
  onChange,
}: {
  type: "date" | "time";
  value: string;
  label: string;
  empty: string;
  min?: string;
  required?: boolean;
  onChange: (value: string) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const open = () => {
    const input = ref.current;
    if (!input) return;
    try {
      input.showPicker();
    } catch {
      input.focus(); // 고르기 창을 열 수 없는 브라우저는 칸에 바로 입력
    }
  };
  const shown = value ? (type === "date" ? dateWithWeekday(value) : timeLabel(value)) : empty;
  return (
    <span className="todo-pick">
      <button type="button" className={value ? "todo-pick-button" : "todo-pick-button todo-pick-empty"} onClick={open}>
        {shown}
        <svg viewBox="0 0 20 20" aria-hidden="true">
          {type === "date" ? (
            <>
              <rect x="3.5" y="4.5" width="13" height="12" rx="2" />
              <path d="M3.5 8.5h13M7 3v3M13 3v3" />
            </>
          ) : (
            <>
              <circle cx="10" cy="10" r="6.5" />
              <path d="M10 6.5V10l2.5 1.5" />
            </>
          )}
        </svg>
      </button>
      <input
        ref={ref}
        className="todo-pick-input"
        type={type}
        value={value}
        min={min}
        required={required}
        aria-label={label}
        tabIndex={-1}
        onChange={(event) => onChange(event.target.value)}
      />
    </span>
  );
}

function TodoMenu({
  item,
  categories,
  closeAsk,
  onDone,
  onClose,
}: {
  item: TodoItem;
  categories: TodoCategory[];
  /** 바뀔 때마다 취소를 누른 것처럼 */
  closeAsk: number;
  /** 저장, 지우기가 끝나면(화면이 다시 받는다) */
  onDone: (notice?: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [day, setDay] = useState(item.day);
  const [time, setTime] = useState(item.time ?? "");
  const [place, setPlace] = useState(item.place ?? "");
  const [memo, setMemo] = useState(item.memo);
  const [categoryId, setCategoryId] = useState(item.category_id);
  const [forFuture, setForFuture] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const titleRef = useRef(title);
  titleRef.current = title;
  const memoWho = useMemoAudience(categories.find((category) => category.id === categoryId));
  const openCategories = categories.filter((category) => !category.closed || category.id === item.category_id);

  const run = async (action: () => Promise<string | undefined>) => {
    if (busy) return;
    setBusy(true);
    try {
      onDone(await action());
    } catch (failure) {
      setError(todoErrorText(failure));
      setBusy(false);
    }
  };

  const save = () => {
    // 반복 만들기와 바꾸기는 반복 화면에서만(2026-11-23 사용자 요청: TODO 메뉴에서는 반복을 뺌)
    return run(async () => {
      const changes: Record<string, unknown> = {};
      if (titleRef.current.trim() !== item.title) changes.title = titleRef.current.trim();
      if ((time || null) !== item.time) changes.time = time || null;
      if ((place.trim() || null) !== item.place) changes.place = place.trim() || null;
      if (memo.trim() !== item.memo) changes.memo = memo;
      if (categoryId !== item.category_id) changes.category_id = categoryId;
      if (day !== item.day) changes.day = day;
      if (Object.keys(changes).length > 0) await updateTodo(item.id, changes);
      const repeat = item.repeat;
      if (repeat && forFuture) {
        // 앞으로의 반복에도: 이름, 시각, 장소, 메모, 카테고리
        const { day: _skip, ...rest } = changes;
        void _skip;
        if (Object.keys(rest).length > 0) await updateRepeat(repeat.id, rest);
      }
      return day !== item.day ? `${longLabel(day)}로 옮겼어요.` : undefined;
    });
  };

  const moveTo = (target: string) =>
    run(async () => {
      await updateTodo(item.id, { day: target });
      return `${longLabel(target)}로 옮겼어요.`;
    });

  const remove = (scope: "today" | "future") =>
    run(async () => {
      await deleteTodo(item.id, scope);
      return undefined;
    });

  const enter = useEnterKey(() => void save());
  // 저장하지 않은 바뀐 점(메모 포함. 취소하면 모두 되돌아감)
  const dirty =
    title.trim() !== item.title ||
    day !== item.day ||
    (time || null) !== item.time ||
    (place.trim() || null) !== item.place ||
    memo.trim() !== item.memo ||
    categoryId !== item.category_id ||
    forFuture;
  const cancel = () => (dirty ? setLeaving(true) : onClose());
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  const firstAsk = useRef(closeAsk);
  useEffect(() => {
    if (closeAsk !== firstAsk.current) cancelRef.current();
  }, [closeAsk]);

  return (
    <div className="todo-menu" role="group" aria-label={`${item.title} 수정`}>
      <input
        className="todo-menu-title"
        aria-label="이름"
        value={title}
        maxLength={100}
        onChange={(event) => setTitle(event.target.value)}
        {...enter}
      />
      {(item.repeat || item.source === "ai") && (
        <div className="todo-menu-quick">
          {item.repeat && <span className="todo-chip">{repeatLabel(item.repeat)} 반복</span>}
          {item.source === "ai" && <span className="todo-chip">AI가 넣음</span>}
        </div>
      )}
      <div className="todo-props">
        <label className="todo-prop">
          <span className="todo-prop-key">날짜</span>
          <span className="todo-prop-value">
            <PickField type="date" label="날짜" value={day} empty="" required onChange={(value) => value && setDay(value)} />
            <MoveDate value={item.day} disabled={busy} onPick={(target) => void moveTo(target)} />
          </span>
        </label>
        <label className="todo-prop">
          <span className="todo-prop-key">시각</span>
          <span className="todo-prop-value">
            <PickField type="time" label="시각" value={time} empty="없음" onChange={setTime} />
            {time && (
              <button type="button" className="todo-link-button" onClick={() => setTime("")} aria-label="시각 삭제">
                삭제
              </button>
            )}
          </span>
        </label>
        <label className="todo-prop">
          <span className="todo-prop-key">장소</span>
          <span className="todo-prop-value">
            <input value={place} maxLength={40} placeholder="비어 있음" onChange={(event) => setPlace(event.target.value)} {...enter} />
          </span>
        </label>
        <label className="todo-prop">
          <span className="todo-prop-key">카테고리</span>
          <span className="todo-prop-value">
            <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
              {openCategories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </span>
        </label>
      </div>
      {item.repeat && (
        <label className="todo-check-line">
          <input type="checkbox" checked={forFuture} onChange={(event) => setForFuture(event.target.checked)} />
          이름, 시각, 장소, 메모, 카테고리를 앞으로의 반복에도 적용
        </label>
      )}
      <textarea
        className="todo-menu-memo"
        aria-label="메모"
        value={memo}
        maxLength={1000}
        rows={2}
        onChange={(event) => setMemo(event.target.value)}
      />
      <span className="todo-hint todo-memo-who">{memoAudienceLine(memoWho)}</span>
      {error && <p className="todo-error">{error}</p>}
      {/* 카테고리 편집과 같은 배치: 왼쪽 삭제(글자 단추), 오른쪽 취소, 저장 */}
      <div className="todo-cat-actions todo-menu-actions">
        <div className="todo-cat-actions-side">
          <button type="button" className="todo-text-button todo-danger-text" onClick={() => setConfirming(true)}>
            삭제
          </button>
        </div>
        <div className="todo-cat-actions-main">
          <button type="button" className="todo-small-button" onClick={cancel}>
            취소
          </button>
          <button type="button" className="todo-small-button todo-primary" disabled={busy} onClick={() => void save()}>
            저장
          </button>
        </div>
      </div>
      {leaving && (
        <div className="todo-confirm" role="alertdialog" aria-label="취소 확인">
          <span>바꾼 내용이 저장되지 않아요. 취소할까요?</span>
          <div className="todo-confirm-buttons">
            <button type="button" className="todo-small-button" onClick={() => setLeaving(false)}>
              계속 수정
            </button>
            <button type="button" className="todo-small-button todo-danger" onClick={onClose}>
              확인
            </button>
          </div>
        </div>
      )}
      {confirming && (
        <div className="todo-confirm" role="group" aria-label="삭제 확인">
          <span>
            {item.repeat
              ? "반복 TODO예요. 이날 것만 삭제할까요, 앞으로 것까지 삭제할까요? 어느 쪽이든 휴지통(카테고리 화면 아래)에서 7일 동안 되살릴 수 있어요."
              : "이 TODO를 삭제할까요? 휴지통(카테고리 화면 아래)에서 7일 동안 되살릴 수 있어요."}
          </span>
          <div className="todo-confirm-buttons">
            <button type="button" className="todo-small-button" onClick={() => setConfirming(false)}>
              취소
            </button>
            <button type="button" className="todo-small-button todo-danger" disabled={busy} onClick={() => void remove("today")}>
              {item.repeat ? "이날 것만" : "삭제"}
            </button>
            {item.repeat && (
              <button type="button" className="todo-small-button todo-danger" disabled={busy} onClick={() => void remove("future")}>
                앞으로도
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ TODO 한 줄

export function TodoRow({
  item,
  categories,
  onToggle,
  onDone,
}: {
  item: TodoItem;
  categories: TodoCategory[];
  onToggle: () => void;
  onDone: (notice?: string) => void;
}) {
  const [reactions, setReactions] = useState(item.reactions ?? []);
  useEffect(() => setReactions(item.reactions ?? []), [item.reactions]);
  const [open, setOpen] = useState(false);
  // 열린 메뉴의 이름을 다시 누르면 '취소'와 같게(바꾼 것이 있으면 확인)
  const [closeAsk, setCloseAsk] = useState(0);
  const [memoOpen, setMemoOpen] = useState(false);
  const meta = [
    item.time ? timeLabel(item.time) : "",
    item.place ?? "",
    item.repeat ? repeatLabel(item.repeat) : "",
  ]
    .filter(Boolean)
    .join(" | ");
  return (
    <li className={item.done ? "todo-row todo-row-done" : "todo-row"}>
      <div className="todo-row-line">
        <button
          type="button"
          className={item.done ? "todo-check todo-check-on" : "todo-check"}
          style={checkStyle(categories.find((category) => category.id === item.category_id)?.color)}
          aria-pressed={item.done}
          aria-label={item.done ? `${item.title} 완료 취소` : `${item.title} 완료`}
          onClick={onToggle}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d={CHECK_PATH} />
          </svg>
        </button>
        <button
          type="button"
          className="todo-title"
          aria-expanded={open}
          onClick={() => (open ? setCloseAsk((value) => value + 1) : setOpen(true))}
        >
          <span className="todo-title-text">{item.title}</span>
          {meta && <span className="todo-meta">{meta}</span>}
        </button>
        {item.memo && (
          <button
            type="button"
            className={memoOpen ? "todo-memo-button todo-memo-button-on" : "todo-memo-button"}
            aria-expanded={memoOpen}
            aria-label={memoOpen ? "메모 접기" : "메모 보기"}
            onClick={() => setMemoOpen(!memoOpen)}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M4 1.5h8.5l4 4v13H4z" />
              <path d="M12.5 1.5v4h4M7 10h6.5M7 13.5h5" />
            </svg>
          </button>
        )}
      </div>
      {reactions.length > 0 && (
        <TodoReactions owner={null} itemId={item.id} reactions={reactions} canAdd={false} onChange={setReactions} />
      )}
      {memoOpen && item.memo && !open && <MemoText text={item.memo} />}
      {open && (
        <TodoMenu
          item={item}
          categories={categories}
          closeAsk={closeAsk}
          onClose={() => setOpen(false)}
          onDone={(notice) => {
            setOpen(false);
            onDone(notice);
          }}
        />
      )}
    </li>
  );
}

// ------------------------------------------------------------ 카테고리 묶음과 입력칸

export interface NewTodoValues {
  title: string;
  day: string;
  time: string | null;
  place: string | null;
  memo: string;
}

export function CategoryBlock({
  category,
  items,
  categories,
  viewDay,
  onAdd,
  onToggle,
  onDone,
}: {
  category: TodoCategory;
  items: TodoItem[];
  categories: TodoCategory[];
  viewDay: string;
  onAdd: (values: NewTodoValues) => Promise<boolean>;
  onToggle: (item: TodoItem) => void;
  onDone: (notice?: string) => void;
}) {
  const [text, setText] = useState("");
  // 넣을 때 칸: 날짜, 시각, 장소, 메모(2026-11-23 사용자 요청 '이름만이 아니라 모든 칸'). 비우면 쓴 글에서 뗀 값
  const [fields, setFields] = useState({ day: "", time: "", place: "", memo: "" });
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const memoWho = useMemoAudience(category);
  const [raw, setRaw] = useState(false); // 미리보기 ×: 이번에는 떼지 않고 글자 그대로
  const parsed = useMemo(() => (raw ? null : parseWhen(text, today())), [text, raw]);
  const shown = parsed?.found ? parsed : null;
  const textRef = useRef(text);
  textRef.current = text;
  const parsedRef = useRef(shown);
  parsedRef.current = shown;
  const busy = useRef(false);

  useEffect(() => {
    if (!text) setRaw(false);
  }, [text]);

  const submit = async (chosenTime?: string | null) => {
    const value = textRef.current.trim();
    const found = parsedRef.current;
    if (!value || busy.current) return;
    if (found?.ask && chosenTime === undefined && !fieldsRef.current.time) return; // 오전, 오후를 고를 때까지 넣지 않는다
    busy.current = true;
    const parsedValues: NewTodoValues = found
      ? {
          title: found.title,
          day: found.day ?? viewDay,
          time: found.ask ? (chosenTime ?? null) : found.time,
          place: found.place,
          memo: found.memo ?? "",
        }
      : { title: value, day: viewDay, time: null, place: null, memo: "" };
    const typed = fieldsRef.current;
    const values: NewTodoValues = {
      title: parsedValues.title,
      day: typed.day || parsedValues.day,
      time: typed.time || parsedValues.time,
      place: typed.place.trim() || parsedValues.place,
      memo: typed.memo.trim() || parsedValues.memo,
    };
    if (await onAdd(values)) {
      setText(""); // 칸은 열린 채로 이어서 입력
      setFields({ day: "", time: "", place: "", memo: "" });
    }
    busy.current = false;
  };
  const enter = useEnterKey(() => void submit());

  let preview: ReactNode = null;
  if (shown) {
    const bits = [
      shown.day && shown.day !== viewDay ? longLabel(shown.day) : "",
      shown.time ? timeLabel(shown.time) : "",
      shown.place ?? "",
      shown.memo ? "메모 있음" : "",
    ].filter(Boolean);
    preview = (
      <div className="todo-preview" role="status">
        <div className="todo-preview-line">
          <span>
            {bits.length > 0 ? `${bits.join(" | ")}: ` : ""}
            <strong>{shown.title}</strong>
          </span>
          <button type="button" className="todo-preview-raw" aria-label="떼지 않고 쓴 그대로 넣기" onClick={() => setRaw(true)}>
            ×
          </button>
        </div>
        {shown.ask && (
          <div className="todo-ask">
            <span>{shown.ask.label}가 오전인가요, 오후인가요?</span>
            <div className="todo-confirm-buttons">
              <button type="button" className="todo-small-button" onClick={() => void submit(shown.ask?.am)}>
                오전 ({timeLabel(shown.ask.am)})
              </button>
              <button type="button" className="todo-small-button todo-primary" onClick={() => void submit(shown.ask?.pm)}>
                오후 ({timeLabel(shown.ask.pm)})
              </button>
              <button type="button" className="todo-small-button" onClick={() => void submit(null)}>
                시각 없이
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="todo-block" aria-label={category.name}>
      <h2 className="todo-cat" style={checkStyle(category.color)}>
        <CategoryDot color={category.color} />
        {category.name}
      </h2>
      <ul className="todo-list">
        {items.map((item) => (
          <TodoRow key={item.id} item={item} categories={categories} onToggle={() => onToggle(item)} onDone={onDone} />
        ))}
      </ul>
      {!category.closed && (
        <form
          className="todo-add"
          onClick={(event) => {
            const input = (event.currentTarget as HTMLFormElement).querySelector<HTMLInputElement>(".todo-add-input");
            const inFields = event.target instanceof Element && event.target.closest(".todo-add-fields");
            if (event.target !== input && !inFields && !(event.target instanceof HTMLButtonElement)) input?.focus();
          }}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <span className="todo-check todo-check-ghost todo-add-plus" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </span>
          <input
            className="todo-add-input"
            value={text}
            maxLength={200}
            placeholder=""
            aria-label={`${category.name}에 TODO 입력`}
            enterKeyHint="done"
            onChange={(event) => setText(event.target.value)}
            {...enter}
          />
          {text.trim() && (!shown?.ask || fields.time) && (
            <button type="submit" className="todo-small-button todo-add-button">
              추가
            </button>
          )}
          <div
            className={
              text || fields.day || fields.time || fields.place || fields.memo
                ? "todo-add-fields todo-add-fields-on"
                : "todo-add-fields"
            }
          >
            <div className="todo-add-field todo-pick-boxed">
              <span>날짜</span>
              <PickField
                type="date"
                label="날짜"
                value={fields.day || shown?.day || viewDay}
                empty=""
                required
                onChange={(value) => value && setFields({ ...fields, day: value })}
              />
            </div>
            <div className="todo-add-field todo-pick-boxed">
              <span>시각</span>
              <span className="todo-pick-row">
                <PickField
                  type="time"
                  label="시각"
                  value={fields.time || (shown?.ask ? "" : (shown?.time ?? ""))}
                  empty="없음"
                  onChange={(value) => setFields({ ...fields, time: value })}
                />
                {fields.time && (
                  <button type="button" className="todo-link-button" onClick={() => setFields({ ...fields, time: "" })}>
                    삭제
                  </button>
                )}
              </span>
            </div>
            <label className="todo-add-field todo-add-field-wide">
              <span>장소</span>
              <input
                value={fields.place}
                maxLength={40}
                placeholder={shown?.place ?? ""}
                onChange={(event) => setFields({ ...fields, place: event.target.value })}
                {...enter}
              />
            </label>
            <label className="todo-add-field todo-add-field-full">
              <span>메모</span>
              <textarea
                value={fields.memo}
                maxLength={1000}
                rows={2}
                onChange={(event) => setFields({ ...fields, memo: event.target.value })}
              />
            </label>
            <span className="todo-hint todo-memo-who todo-add-field-full">{memoAudienceLine(memoWho)}</span>
          </div>
        </form>
      )}
      {preview}
    </section>
  );
}

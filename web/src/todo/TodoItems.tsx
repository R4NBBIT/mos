// 할 일 한 줄과 할 일 메뉴(SCR-03), 카테고리 묶음의 입력칸(날짜 알아보기, TODO-13~15)
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { addDays, longLabel, timeLabel, today, WEEKDAY_NAMES } from "./dates";
import { useEnterKey } from "./enterKey";
import { parseWhen } from "./parseWhen";
import {
  createRepeat,
  deleteTodo,
  type RepeatRule,
  stopRepeat,
  type TodoCategory,
  todoErrorText,
  type TodoItem,
  type TodoRepeat,
  updateRepeat,
  updateTodo,
} from "./todoApi";

const CHECK_PATH = "M5 12.5l4.5 4.5L19 7.5";

function needsRing(color: string): boolean {
  const value = Number.parseInt(color.slice(1), 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 255) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0) > 0.6;
}

export function CategoryDot({ color }: { color: string }) {
  return <span className={needsRing(color) ? "todo-dot todo-dot-ring" : "todo-dot"} style={{ background: color }} />;
}

export function repeatLabel(repeat: TodoRepeat): string {
  if (repeat.rule === "daily") return "매일";
  if (repeat.rule === "weekdays") return "평일마다";
  if (repeat.rule === "monthly") return "매달";
  return `매주 ${repeat.weekdays.map((day) => WEEKDAY_NAMES[day]).join(" ")}`;
}

/** 메모 글자: http, https 주소만 누를 수 있는 링크로(ㅁㅇㅅ 본문 링크 규칙과 같음) */
function MemoText({ text }: { text: string }) {
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

// ------------------------------------------------------------ 할 일 메뉴

type RuleChoice = "none" | RepeatRule;

function TodoMenu({
  item,
  categories,
  onDone,
  onClose,
}: {
  item: TodoItem;
  categories: TodoCategory[];
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
  const [rule, setRule] = useState<RuleChoice>(item.repeat?.rule ?? "none");
  const [weekdays, setWeekdays] = useState<number[]>(item.repeat?.weekdays ?? [new Date(`${item.day}T12:00`).getDay()]);
  const [endDay, setEndDay] = useState(item.repeat?.end_day ?? "");
  const [forFuture, setForFuture] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const titleRef = useRef(title);
  titleRef.current = title;
  const isPast = item.day < today();
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
    if (rule === "weekly" && weekdays.length === 0) {
      setError("요일을 하나 이상 골라 주세요.");
      return;
    }
    return run(async () => {
      const changes: Record<string, unknown> = {};
      if (titleRef.current.trim() !== item.title) changes.title = titleRef.current.trim();
      if ((time || null) !== item.time) changes.time = time || null;
      if ((place.trim() || null) !== item.place) changes.place = place.trim() || null;
      if (memo.trim() !== item.memo) changes.memo = memo;
      if (categoryId !== item.category_id) changes.category_id = categoryId;
      if (day !== item.day) changes.day = day;
      let saved = item;
      if (Object.keys(changes).length > 0) saved = await updateTodo(item.id, changes);
      const repeat = item.repeat;
      if (repeat && forFuture) {
        // 앞으로의 반복에도: 이름, 시각, 장소, 메모, 카테고리
        const { day: _skip, ...rest } = changes;
        void _skip;
        if (Object.keys(rest).length > 0) await updateRepeat(repeat.id, rest);
      }
      if (repeat) {
        // 다른 날로 옮긴 회차는 따로인 할 일이 되므로 반복은 건드리지 않는다
        if (day === item.day) {
          if (rule === "none") await stopRepeat(repeat.id, item.day);
          else if (
            rule !== repeat.rule ||
            (endDay || null) !== repeat.end_day ||
            (rule === "weekly" && weekdays.join() !== repeat.weekdays.join())
          ) {
            await updateRepeat(repeat.id, { rule, weekdays: rule === "weekly" ? weekdays : undefined, end_day: endDay || null });
          }
        }
      } else if (rule !== "none") {
        await createRepeat(saved.id, { rule, weekdays: rule === "weekly" ? weekdays : undefined, end_day: endDay || null });
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
  const toggleDay = (value: number) =>
    setWeekdays((current) => (current.includes(value) ? current.filter((d) => d !== value) : [...current, value].sort()));

  return (
    <div className="todo-menu" role="group" aria-label={`${item.title} 고치기`}>
      <div className="todo-menu-quick">
        <button type="button" className="todo-small-button" disabled={busy} onClick={() => void moveTo(isPast ? today() : addDays(item.day, 1))}>
          {isPast ? "오늘 하기" : "내일 하기"}
        </button>
        {item.repeat && <span className="todo-chip">{repeatLabel(item.repeat)} 반복</span>}
        {item.source === "ai" && <span className="todo-chip">AI가 넣음</span>}
      </div>
      <label className="todo-field todo-field-wide">
        이름
        <input value={title} maxLength={100} onChange={(event) => setTitle(event.target.value)} {...enter} />
      </label>
      <div className="todo-menu-grid">
        <label className="todo-field">
          날짜
          <input type="date" value={day} required onChange={(event) => event.target.value && setDay(event.target.value)} />
        </label>
        <label className="todo-field">
          시각
          <span className="todo-field-row">
            <input type="time" value={time} onChange={(event) => setTime(event.target.value)} />
            {time && (
              <button type="button" className="todo-small-button" onClick={() => setTime("")} aria-label="시각 지우기">
                지우기
              </button>
            )}
          </span>
        </label>
        <label className="todo-field">
          장소
          <input value={place} maxLength={40} placeholder="없음" onChange={(event) => setPlace(event.target.value)} {...enter} />
        </label>
        <label className="todo-field">
          카테고리
          <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
            {openCategories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="todo-field todo-field-wide">
        메모
        <textarea value={memo} maxLength={1000} rows={3} placeholder="나만 보여요(카테고리에서 보여 주기를 켜지 않으면)" onChange={(event) => setMemo(event.target.value)} />
      </label>
      <div className="todo-field todo-field-wide">
        반복
        <select
          aria-label="반복"
          value={rule}
          onChange={(event) => setRule(event.target.value as RuleChoice)}
        >
          <option value="none">안 함</option>
          <option value="daily">매일</option>
          <option value="weekdays">평일마다</option>
          <option value="weekly">매주 고른 요일</option>
          <option value="monthly">매달 같은 날</option>
        </select>
        {rule === "weekly" && (
          <div className="todo-weekdays" role="group" aria-label="반복할 요일">
            {WEEKDAY_NAMES.map((name, index) => (
              <button
                key={name}
                type="button"
                aria-pressed={weekdays.includes(index)}
                className={weekdays.includes(index) ? "todo-weekday todo-weekday-on" : "todo-weekday"}
                onClick={() => toggleDay(index)}
              >
                {name}
              </button>
            ))}
          </div>
        )}
        {rule !== "none" && (
          <label className="todo-field">
            끝나는 날(비우면 계속)
            <input type="date" value={endDay} min={item.repeat ? undefined : item.day} onChange={(event) => setEndDay(event.target.value)} />
          </label>
        )}
        {rule === "none" && item.repeat && (
          <span className="todo-hint">저장하면 이날부터 반복을 그만해요. 이 할 일은 남아요.</span>
        )}
        {item.repeat && (
          <label className="todo-check-line">
            <input type="checkbox" checked={forFuture} onChange={(event) => setForFuture(event.target.checked)} />
            이름, 시각, 장소, 메모, 카테고리를 앞으로의 반복에도 적용
          </label>
        )}
      </div>
      {error && <p className="todo-error">{error}</p>}
      <div className="todo-edit-actions">
        <button type="button" className="todo-small-button todo-primary" disabled={busy} onClick={() => void save()}>
          저장
        </button>
        <button type="button" className="todo-small-button" onClick={onClose}>
          닫기
        </button>
        <span className="todo-spacer" />
        <button type="button" className="todo-small-button todo-danger-text" onClick={() => setConfirming(true)}>
          지우기
        </button>
      </div>
      {confirming && (
        <div className="todo-confirm" role="group" aria-label="지우기 확인">
          <span>
            {item.repeat
              ? "반복 할 일이에요. 이날 것만 지우거나 앞으로 것까지 지울 수 있어요. 되돌릴 수 없어요."
              : "이 할 일을 지울까요? 되돌릴 수 없어요."}
          </span>
          <div className="todo-confirm-buttons">
            <button type="button" className="todo-small-button" onClick={() => setConfirming(false)}>
              취소
            </button>
            <button type="button" className="todo-small-button todo-danger" disabled={busy} onClick={() => void remove("today")}>
              {item.repeat ? "이날 것만" : "지우기"}
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

// ------------------------------------------------------------ 할 일 한 줄

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
  const [open, setOpen] = useState(false);
  const [memoOpen, setMemoOpen] = useState(false);
  const meta = [item.time ? timeLabel(item.time) : "", item.place ?? "", item.repeat ? repeatLabel(item.repeat) : ""]
    .filter(Boolean)
    .join(", ");
  return (
    <li className={item.done ? "todo-row todo-row-done" : "todo-row"}>
      <div className="todo-row-line">
        <button
          type="button"
          className={item.done ? "todo-check todo-check-on" : "todo-check"}
          aria-pressed={item.done}
          aria-label={item.done ? `${item.title} 완료 취소` : `${item.title} 완료`}
          onClick={onToggle}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d={CHECK_PATH} />
          </svg>
        </button>
        <button type="button" className="todo-title" aria-expanded={open} onClick={() => setOpen(!open)}>
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
              <path d="M5 3h7l3 3v11H5z" />
              <path d="M8 10h5M8 13h4" />
            </svg>
          </button>
        )}
      </div>
      {memoOpen && item.memo && !open && <MemoText text={item.memo} />}
      {open && (
        <TodoMenu
          item={item}
          categories={categories}
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
    if (found?.ask && chosenTime === undefined) return; // 오전, 오후를 고를 때까지 넣지 않는다
    busy.current = true;
    const values: NewTodoValues = found
      ? {
          title: found.title,
          day: found.day ?? viewDay,
          time: found.ask ? (chosenTime ?? null) : found.time,
          place: found.place,
          memo: found.memo ?? "",
        }
      : { title: value, day: viewDay, time: null, place: null, memo: "" };
    if (await onAdd(values)) setText(""); // 칸은 열린 채로 이어서 입력
    busy.current = false;
  };
  const enter = useEnterKey(() => void submit());

  let preview: ReactNode = null;
  if (shown) {
    const bits = [
      shown.day && shown.day !== viewDay ? longLabel(shown.day) : "",
      shown.time ? timeLabel(shown.time) : "",
      shown.place ? `@${shown.place}` : "",
      shown.memo ? "메모 있음" : "",
    ].filter(Boolean);
    preview = (
      <div className="todo-preview" role="status">
        <div className="todo-preview-line">
          <span>
            {bits.length > 0 ? `${bits.join(", ")}: ` : ""}
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
                오전 {timeLabel(shown.ask.am).replace("오전 ", "")}
              </button>
              <button type="button" className="todo-small-button todo-primary" onClick={() => void submit(shown.ask?.pm)}>
                오후 {timeLabel(shown.ask.pm).replace("오후 ", "")}
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
      <h2 className="todo-cat">
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
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <span className="todo-check todo-check-ghost" aria-hidden="true" />
          <input
            className="todo-add-input"
            value={text}
            maxLength={200}
            placeholder="할 일 입력"
            title="예: 내일 오후 3시 치과 @강남역 // 메모"
            aria-label={`${category.name}에 할 일 입력`}
            enterKeyHint="done"
            onChange={(event) => setText(event.target.value)}
            {...enter}
          />
          {text.trim() && !shown?.ask && (
            <button type="submit" className="todo-small-button todo-add-button">
              추가
            </button>
          )}
        </form>
      )}
      {preview}
    </section>
  );
}

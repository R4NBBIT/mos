// 할 일(공개 전): 하루 화면(SCR-02, 넓은 화면 오른쪽)과 넓은 화면 왼쪽 달력(SCR-04)
// 허용된 계정에서만 이 파일을 내려받는다(App에서 lazy). 테마 색은 ㅁㅇㅅ CSS 변수를 그대로 쓴다
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import BackIcon from "../BackIcon";
import SplitToggle from "../SplitToggle";
import {
  addDays,
  isDayKey,
  longLabel,
  monthGrid,
  monthLabel,
  monthStart,
  shiftMonth,
  timeLabel,
  today,
  WEEKDAY_NAMES,
  weekOf,
} from "./dates";
import {
  addCategory,
  addTodo,
  type DaySummary,
  deleteTodo,
  fetchTodoDay,
  fetchTodoDays,
  type TodoCategory,
  type TodoDay,
  todoErrorText,
  type TodoItem,
  updateTodo,
} from "./todoApi";
import "./todo.css";

const PRESET_COLORS = ["#FFD66B", "#2563EB", "#7C5CDB", "#16A34A", "#C2410C", "#DB2777", "#0891B2"];

/** 화면 바탕과 잘 구분되지 않는 아주 밝은 색이면 얇은 테두리(CAT-11) */
function needsRing(color: string): boolean {
  const value = Number.parseInt(color.slice(1), 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 255) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  return luminance > 0.6;
}

function CategoryDot({ color }: { color: string }) {
  return <span className={needsRing(color) ? "todo-dot todo-dot-ring" : "todo-dot"} style={{ background: color }} />;
}

const CHECK_PATH = "M5 12.5l4.5 4.5L19 7.5";

/** 그 주(또는 몇 주)의 날짜별 요약. 날짜가 바뀌거나 할 일이 바뀌면 다시 */
function useSummary(start: string, end: string, version: number): DaySummary {
  const [summary, setSummary] = useState<DaySummary>({});
  useEffect(() => {
    let stopped = false;
    fetchTodoDays(start, end)
      .then((value) => {
        if (!stopped) setSummary(value);
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [start, end, version]);
  return summary;
}

function DayMark({ day, summary }: { day: string; summary: DaySummary }) {
  const info = summary[day];
  if (!info || info.total === 0) return <span className="todo-mark" />;
  if (info.done >= info.total) return <span className="todo-mark todo-mark-done" aria-label="다 했어요" />;
  return <span className="todo-mark todo-mark-left">{info.total - info.done}</span>;
}

// ------------------------------------------------------------ 할 일 한 줄

function TodoRow({
  item,
  onChange,
  onDelete,
}: {
  item: TodoItem;
  onChange: (changes: Partial<TodoItem>) => Promise<boolean>;
  onDelete: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState(item.title);
  const meta = [item.time ? timeLabel(item.time) : "", item.place ?? ""].filter(Boolean).join(", ");

  const save = async () => {
    const title = draft.trim();
    if (!title || title === item.title) {
      setDraft(item.title);
      setEditing(false);
      return;
    }
    if (await onChange({ title })) setEditing(false);
  };

  return (
    <li className={item.done ? "todo-row todo-row-done" : "todo-row"}>
      <button
        type="button"
        className={item.done ? "todo-check todo-check-on" : "todo-check"}
        aria-pressed={item.done}
        aria-label={item.done ? `${item.title} 완료 취소` : `${item.title} 완료`}
        onClick={() => void onChange({ done: !item.done })}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d={CHECK_PATH} />
        </svg>
      </button>
      {editing ? (
        <div
          className="todo-edit"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            setDraft(item.title);
            setEditing(false);
            setConfirming(false);
          }}
        >
          <input
            className="todo-edit-input"
            value={draft}
            maxLength={100}
            autoFocus
            aria-label="할 일 고치기"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) void save();
            }}
          />
          <div className="todo-edit-actions">
            <button type="button" className="todo-small-button" onClick={() => void save()}>
              저장
            </button>
            <button type="button" className="todo-small-button todo-danger-text" onClick={() => setConfirming(true)}>
              지우기
            </button>
          </div>
          {confirming && (
            <div className="todo-confirm" role="group" aria-label="지우기 확인">
              <span>이 할 일을 지울까요? 되돌릴 수 없어요.</span>
              <div className="todo-confirm-buttons">
                <button type="button" className="todo-small-button" onClick={() => setConfirming(false)}>
                  취소
                </button>
                <button type="button" className="todo-small-button todo-danger" onClick={() => void onDelete()}>
                  지우기
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <button
          type="button"
          className="todo-title"
          onClick={() => {
            setDraft(item.title);
            setEditing(true);
          }}
        >
          <span className="todo-title-text">{item.title}</span>
          {meta && <span className="todo-meta">{meta}</span>}
        </button>
      )}
    </li>
  );
}

// ------------------------------------------------------------ 카테고리 묶음

function CategoryBlock({
  category,
  items,
  onAdd,
  onChange,
  onDelete,
}: {
  category: TodoCategory;
  items: TodoItem[];
  onAdd: (title: string) => Promise<boolean>;
  onChange: (item: TodoItem, changes: Partial<TodoItem>) => Promise<boolean>;
  onDelete: (item: TodoItem) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const title = text.trim();
    if (!title || busy) return;
    setBusy(true);
    if (await onAdd(title)) setText(""); // 칸은 열린 채로 이어서 입력
    setBusy(false);
  };
  return (
    <section className="todo-block" aria-label={category.name}>
      <h2 className="todo-cat">
        <CategoryDot color={category.color} />
        {category.name}
      </h2>
      <ul className="todo-list">
        {items.map((item) => (
          <TodoRow
            key={item.id}
            item={item}
            onChange={(changes) => onChange(item, changes)}
            onDelete={() => onDelete(item)}
          />
        ))}
      </ul>
      {!category.closed && (
        <form className="todo-add" onSubmit={(event) => void submit(event)}>
          <span className="todo-check todo-check-ghost" aria-hidden="true" />
          <input
            className="todo-add-input"
            value={text}
            maxLength={100}
            placeholder="할 일 입력"
            aria-label={`${category.name}에 할 일 입력`}
            enterKeyHint="done"
            onChange={(event) => setText(event.target.value)}
          />
        </form>
      )}
    </section>
  );
}

function NewCategory({ count, onMade }: { count: number; onMade: (category: TodoCategory) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = name.trim();
    if (!value) return;
    try {
      onMade(await addCategory(value, PRESET_COLORS[count % PRESET_COLORS.length] ?? "#FFD66B"));
      setName("");
      setOpen(false);
      setError("");
    } catch (failure) {
      setError(todoErrorText(failure));
    }
  };
  if (!open) {
    return (
      <button type="button" className="todo-new-cat" onClick={() => setOpen(true)}>
        + 카테고리
      </button>
    );
  }
  return (
    <form className="todo-new-cat-form" onSubmit={(event) => void submit(event)}>
      <input
        value={name}
        maxLength={20}
        autoFocus
        placeholder="카테고리 이름"
        aria-label="새 카테고리 이름"
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      />
      <button type="submit" className="todo-small-button">
        만들기
      </button>
      <button type="button" className="todo-small-button" onClick={() => setOpen(false)}>
        취소
      </button>
      {error && <p className="todo-error">{error}</p>}
    </form>
  );
}

// ------------------------------------------------------------ 하루 화면

export interface TodoScreenProps {
  day: string;
  onDay: (day: string) => void;
  showBack: boolean;
  onBack: () => void;
  menu: ReactNode;
  notice: string;
  onNoticeClose: () => void;
  /** 할 일이 바뀌면(왼쪽 달력, 서버 목록 요약을 다시) */
  onChanged?: () => void;
  version?: number;
}

export default function TodoScreen({
  day: rawDay,
  onDay,
  showBack,
  onBack,
  menu,
  notice,
  onNoticeClose,
  onChanged,
  version = 0,
}: TodoScreenProps) {
  const day = isDayKey(rawDay) ? rawDay : today();
  const [data, setData] = useState<TodoDay | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState("");
  const [bump, setBump] = useState(0);
  const dayRef = useRef(day);
  dayRef.current = day;

  const load = useCallback(async () => {
    try {
      const value = await fetchTodoDay(day);
      if (dayRef.current === day) {
        setData(value);
        setFailed(false);
      }
    } catch {
      if (dayRef.current === day) setFailed(true);
    }
  }, [day]);

  useEffect(() => {
    setData((current) => (current?.day === day ? current : null));
    void load();
  }, [load, version]);

  useEffect(() => {
    // 다른 기기에서 고쳤을 수 있어, 탭으로 돌아오면 다시 받는다
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  const changed = () => {
    setBump((value) => value + 1);
    onChanged?.();
  };

  const week = useMemo(() => weekOf(day), [day]);
  const summary = useSummary(week[0] ?? day, week[6] ?? day, bump + version);

  const replaceItem = (next: TodoItem) =>
    setData((current) =>
      current
        ? {
            ...current,
            items:
              next.day === current.day
                ? current.items.map((item) => (item.id === next.id ? next : item))
                : current.items.filter((item) => item.id !== next.id),
          }
        : current,
    );

  const add = async (category: TodoCategory, title: string) => {
    try {
      const made = await addTodo({ title, day, category_id: category.id });
      setData((current) => (current ? { ...current, items: [...current.items, made] } : current));
      setError("");
      changed();
      return true;
    } catch (failure) {
      setError(todoErrorText(failure));
      return false;
    }
  };

  const change = async (item: TodoItem, changes: Partial<TodoItem>) => {
    replaceItem({ ...item, ...changes }); // 바로 보이게 하고 실패하면 되돌린다
    try {
      replaceItem(await updateTodo(item.id, changes));
      setError("");
      changed();
      return true;
    } catch (failure) {
      replaceItem(item);
      setError(todoErrorText(failure));
      return false;
    }
  };

  const remove = async (item: TodoItem) => {
    try {
      await deleteTodo(item.id);
      setData((current) => (current ? { ...current, items: current.items.filter((it) => it.id !== item.id) } : current));
      changed();
    } catch (failure) {
      setError(todoErrorText(failure));
    }
  };

  const items = data?.items ?? [];
  const doneCount = items.filter((item) => item.done).length;
  const sub = data ? (items.length === 0 ? "할 일이 없어요" : `${doneCount}개 했어요, ${items.length - doneCount}개 남음`) : "";
  const isToday = day === today();

  return (
    <div className="room todo-room">
      <header className="room-header">
        <SplitToggle />
        {showBack && (
          <button type="button" className="back-button" onClick={onBack} aria-label="서버 목록으로">
            <BackIcon />
          </button>
        )}
        <div className="room-title">
          <strong>{longLabel(day)}</strong>
          <span className="room-sub">{sub}</span>
        </div>
        {!isToday && (
          <button type="button" className="todo-small-button" onClick={() => onDay(today())}>
            오늘
          </button>
        )}
        {menu}
      </header>
      {notice && (
        <div className="room-notice" role="status">
          <span>{notice}</span>
          <button type="button" className="text-button" onClick={onNoticeClose} aria-label="안내 닫기">
            닫기
          </button>
        </div>
      )}
      <nav className="todo-week" aria-label="이번 주">
        <button type="button" className="todo-week-move" aria-label="지난주" onClick={() => onDay(addDays(day, -7))}>
          <BackIcon />
        </button>
        {week.map((key) => (
          <button
            key={key}
            type="button"
            className={key === day ? "todo-week-day todo-week-day-on" : "todo-week-day"}
            aria-current={key === day ? "date" : undefined}
            aria-label={longLabel(key)}
            onClick={() => onDay(key)}
          >
            <span className="todo-week-name">{WEEKDAY_NAMES[week.indexOf(key)]}</span>
            <span className={key === today() ? "todo-week-num todo-week-today" : "todo-week-num"}>
              {Number(key.slice(8))}
            </span>
            <DayMark day={key} summary={summary} />
          </button>
        ))}
        <button
          type="button"
          className="todo-week-move todo-week-next"
          aria-label="다음 주"
          onClick={() => onDay(addDays(day, 7))}
        >
          <BackIcon />
        </button>
      </nav>
      <div className="todo-body">
        {error && (
          <p className="todo-error" role="alert">
            {error}
          </p>
        )}
        {data === null && <p className="list-note">{failed ? "불러오지 못했어요. 잠시 뒤 다시 열어 주세요." : "불러오는 중…"}</p>}
        {data?.categories.map((category) => (
          <CategoryBlock
            key={category.id}
            category={category}
            items={items.filter((item) => item.category_id === category.id)}
            onAdd={(title) => add(category, title)}
            onChange={change}
            onDelete={remove}
          />
        ))}
        {data && (
          <NewCategory
            count={data.categories.length}
            onMade={(category) =>
              setData((current) => (current ? { ...current, categories: [...current.categories, category] } : current))
            }
          />
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ 넓은 화면 왼쪽(SCR-04)

export function TodoSide({
  day,
  name,
  onDay,
  onServers,
  version = 0,
}: {
  day: string;
  name: string;
  onDay: (day: string) => void;
  /** 머리의 '할 일'을 누르면 서버 목록으로 */
  onServers: () => void;
  version?: number;
}) {
  const [month, setMonth] = useState(() => monthStart(isDayKey(day) ? day : today()));
  useEffect(() => {
    if (isDayKey(day)) setMonth(monthStart(day));
  }, [day]);
  const cells = useMemo(() => monthGrid(month), [month]);
  const first = cells.find((cell) => cell !== null) ?? month;
  const last = [...cells].reverse().find((cell) => cell !== null) ?? month;
  const summary = useSummary(first, last, version);
  const now = today();
  const mine = summary[day];

  return (
    <div className="room list-room todo-side">
      <header className="room-header">
        <div className="room-title">
          <button type="button" className="todo-side-switch" onClick={onServers} aria-label="서버 목록 보기">
            <strong>할 일</strong>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 6l4 4 4-4" />
            </svg>
          </button>
        </div>
      </header>
      <div className="todo-side-body">
        <div className="todo-month">
          <div className="todo-month-head">
            <button type="button" className="todo-week-move" aria-label="지난달" onClick={() => setMonth(shiftMonth(month, -1))}>
              <BackIcon />
            </button>
            <span>{monthLabel(month)}</span>
            <button
              type="button"
              className="todo-week-move todo-week-next"
              aria-label="다음 달"
              onClick={() => setMonth(shiftMonth(month, 1))}
            >
              <BackIcon />
            </button>
          </div>
          <div className="todo-month-grid" role="grid" aria-label={monthLabel(month)}>
            {WEEKDAY_NAMES.map((weekday) => (
              <span key={weekday} className="todo-month-weekday" role="columnheader">
                {weekday}
              </span>
            ))}
            {cells.map((cell, index) =>
              cell === null ? (
                <span key={`empty-${index}`} />
              ) : (
                <button
                  key={cell}
                  type="button"
                  className={cell === day ? "todo-month-day todo-month-day-on" : "todo-month-day"}
                  aria-label={longLabel(cell)}
                  aria-current={cell === day ? "date" : undefined}
                  onClick={() => onDay(cell)}
                >
                  <span className={cell === now ? "todo-week-today" : undefined}>{Number(cell.slice(8))}</span>
                  <DayMark day={cell} summary={summary} />
                </button>
              ),
            )}
          </div>
        </div>
        <section className="list-section">
          <h2 className="list-section-title">나와 친구</h2>
          <div className="list-item list-item-active todo-person">
            <span className="todo-person-name">{name}</span>
            <span className="list-sub">{mine ? `${mine.done}/${mine.total}` : "0/0"}</span>
          </div>
        </section>
      </div>
    </div>
  );
}

// TODO(공개 전): 하루 화면(SCR-02, 넓은 화면 오른쪽)과 넓은 화면 왼쪽 달력(SCR-04)
// 허용된 계정에서만 이 파일을 내려받는다(App에서 lazy). 테마 색은 ㅁㅇㅅ CSS 변수를 그대로 쓴다
import { openTodoWidget } from "./TodoWidget";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import BackIcon from "../BackIcon";
import SplitToggle from "../SplitToggle";
import { CategoryBlock, type NewTodoValues } from "./TodoItems";
import {
  addDays,
  isDayKey,
  longLabel,
  monthGrid,
  monthLabel,
  monthStart,
  shiftMonth,
  shortDayLabel,
  today,
  WEEKDAY_NAMES,
  weekOf,
} from "./dates";
import {
  addTodo,
  type DaySummary,
  fetchTodoDay,
  fetchTodoDays,
  type TodoCategory,
  type TodoDay,
  todoErrorText,
  type TodoItem,
  updateTodo,
  fetchTodoNews,
  fetchFriendsToday,
  type TodoPerson,
  TODO_NEWS_EVENT,
} from "./todoApi";
import { onTodoRefresh } from "./todoSync";
import "./todo.css";

const SYNC_MS = 30_000;

/** 그 주(또는 몇 주)의 날짜별 요약. 날짜가 바뀌거나 TODO가 바뀌면 다시 */
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

/** 그날 한 수/전체(예: 1/4). 다 했으면 꿀색 바탕 */
function DayMark({ day, summary }: { day: string; summary: DaySummary }) {
  const info = summary[day];
  if (!info || info.total === 0) return <span className="todo-mark" />;
  const all = info.done >= info.total;
  return (
    <span className={all ? "todo-mark todo-mark-all" : "todo-mark"} aria-label={`${info.total}개 중 ${info.done}개 했어요`}>
      {info.done}/{info.total}
    </span>
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
  /** TODO가 바뀌면(왼쪽 달력, 서버 목록 요약을 다시) */
  onChanged?: () => void;
  version?: number;
  /** 카테고리 관리 화면으로 */
  onCategories: () => void;
  /** 친구 관리(휴대폰은 왼쪽 목록이 없어 머리에서) */
  onFriends?: () => void;
  /** 소식과 알림 화면으로 */
  onAlerts: () => void;
  /** AI 연결 화면으로 */
  onAi: () => void;
  /** 반복 화면으로 */
  onRepeats: () => void;
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
  onCategories,
  onFriends,
  onAlerts,
  onAi,
  onRepeats,
}: TodoScreenProps) {
  const day = isDayKey(rawDay) ? rawDay : today();
  const [data, setData] = useState<TodoDay | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState<{ text: string; day?: string } | null>(null);
  const [bump, setBump] = useState(0);
  const [unread, setUnread] = useState(0);
  const [newsVersion, setNewsVersion] = useState(0);
  useEffect(() => {
    let stopped = false;
    fetchTodoNews()
      .then((news) => !stopped && setUnread(news.unread))
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [newsVersion]);
  useEffect(() => {
    const refresh = () => setNewsVersion((value) => value + 1);
    window.addEventListener(TODO_NEWS_EVENT, refresh);
    return () => window.removeEventListener(TODO_NEWS_EVENT, refresh);
  }, []);
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

  // 다른 창(위젯)이나 다른 기기에서 바꿨을 수 있어: 알림을 받거나, 탭으로 돌아오거나, 30초마다 다시 받는다
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  useEffect(
    () =>
      onTodoRefresh(() => {
        if (onChangedRef.current) onChangedRef.current(); // 왼쪽 달력 요약까지(version이 바뀌며 다시 받음)
        else void load();
      }, SYNC_MS),
    [load],
  );

  const changed = () => {
    setBump((value) => value + 1);
    onChanged?.();
  };

  const week = useMemo(() => weekOf(day), [day]);
  const summary = useSummary(week[0] ?? day, week[6] ?? day, bump + version);

  const add = async (category: TodoCategory, values: NewTodoValues) => {
    try {
      const made = await addTodo({ ...values, category_id: category.id });
      if (made.day === day) {
        setData((current) => (current ? { ...current, items: [...current.items, made] } : current));
        setInfo(null);
      } else {
        setInfo({ text: `${longLabel(made.day)}에 넣었어요.`, day: made.day });
      }
      setError("");
      changed();
      return true;
    } catch (failure) {
      setError(todoErrorText(failure));
      return false;
    }
  };

  const toggle = async (item: TodoItem) => {
    const flipped = { ...item, done: !item.done };
    const swap = (from: TodoItem, to: TodoItem) =>
      setData((current) =>
        current ? { ...current, items: current.items.map((it) => (it.id === from.id ? to : it)) } : current,
      );
    swap(item, flipped); // 바로 보이게 하고 실패하면 되돌린다
    try {
      swap(flipped, await updateTodo(item.id, { done: flipped.done })); // 반복 회차면 새 ID로
      setError("");
      changed();
    } catch (failure) {
      swap(flipped, item);
      setError(todoErrorText(failure));
    }
  };

  const done = (notice?: string) => {
    setInfo(notice ? { text: notice } : null);
    void load();
    changed();
  };

  const items = data?.items ?? [];
  const doneCount = items.filter((item) => item.done).length;
  const sub = data ? (items.length === 0 ? "TODO가 없어요" : `${doneCount}개 했어요, ${items.length - doneCount}개 남음`) : "";
  const isToday = day === today();

  return (
    <div className="room todo-room">
      <header className="room-header todo-header">
        <SplitToggle />
        {showBack && (
          <button type="button" className="back-button" onClick={onBack} aria-label="서버 목록으로">
            <BackIcon />
          </button>
        )}
        <div className="room-title">
          <strong>
            <span className="todo-day-long">{longLabel(day)}</span>
            <span className="todo-day-short">{shortDayLabel(day)}</span>
          </strong>
          <span className="room-sub">{sub}</span>
        </div>
        <div className="header-tools">
          {!isToday && (
            <button type="button" className="header-tool" onClick={() => onDay(today())}>
              <span className="header-tool-label todo-tool-always">오늘</span>
            </button>
          )}
          <button
            type="button"
            className="header-tool"
            aria-label={unread > 0 ? `소식과 알림, 새 소식 ${unread}개` : "소식과 알림"}
            onClick={onAlerts}
          >
            <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M5 8.5a5 5 0 0 1 10 0v3.5l1.5 2.5h-13L5 12z" strokeLinejoin="round" />
              <path d="M8 16.5a2 2 0 0 0 4 0" strokeLinecap="round" />
            </svg>
            <span className="header-tool-label">알림</span>
            {unread > 0 && <span className="todo-unread-dot" aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="header-tool"
            aria-label="AI 연결"
            onClick={onAi}
          >
            <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M10 2.5l1.6 4.4 4.4 1.6-4.4 1.6L10 14.5l-1.6-4.4L4 8.5l4.4-1.6z" strokeLinejoin="round" />
              <path d="M15.5 13.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" strokeLinejoin="round" />
            </svg>
            <span className="header-tool-label">AI</span>
          </button>
          {onFriends && (
            <button type="button" className="header-tool" aria-label="친구" onClick={onFriends}>
              <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
                <circle cx="7.5" cy="7" r="3" />
                <path d="M2 17c.6-3 2.8-4.5 5.5-4.5S12.4 14 13 17" strokeLinecap="round" />
                <path d="M13 4.5a2.8 2.8 0 0 1 0 5M15 12.8c1.6.6 2.6 2 3 4.2" strokeLinecap="round" />
              </svg>
              <span className="header-tool-label">친구</span>
            </button>
          )}
          {!onFriends && (
            <button
              type="button"
              className="header-tool"
              aria-label="위젯 창"
              title="오늘 TODO만 작은 창으로(이 탭을 닫아도 남고, 보스키를 누르면 같이 닫혀요)"
              onClick={openTodoWidget}
            >
              <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
                <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
                <rect x="9.5" y="9" width="6" height="5.5" rx="1" />
              </svg>
              <span className="header-tool-label">위젯</span>
            </button>
          )}
          <button type="button" className="header-tool" aria-label="반복 TODO" onClick={onRepeats}>
            <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M4 9a6 6 0 0 1 10.5-3.5L16 7" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M16 3.5V7h-3.5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M16 11a6 6 0 0 1-10.5 3.5L4 13" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M4 16.5V13h3.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="header-tool-label">반복</span>
          </button>
          <button type="button" className="header-tool" aria-label="카테고리 관리" onClick={onCategories}>
            <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
              <rect x="3" y="3.5" width="6" height="6" rx="1.5" />
              <rect x="11" y="3.5" width="6" height="6" rx="1.5" />
              <rect x="3" y="11.5" width="6" height="6" rx="1.5" />
              <path d="M14 11.5v6M11 14.5h6" strokeLinecap="round" />
            </svg>
            <span className="header-tool-label">카테고리</span>
          </button>
        </div>
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
        {info && (
          <p className="todo-info" role="status">
            <span>{info.text}</span>
            {info.day && (
              <button type="button" className="todo-small-button" onClick={() => info.day && onDay(info.day)}>
                보기
              </button>
            )}
            <button type="button" className="todo-small-button" aria-label="안내 닫기" onClick={() => setInfo(null)}>
              닫기
            </button>
          </p>
        )}
        {data === null && <p className="list-note">{failed ? "불러오지 못했어요. 잠시 뒤 다시 열어 주세요." : "불러오는 중…"}</p>}
        {data?.categories.map((category) => (
          <CategoryBlock
            key={category.id}
            category={category}
            items={items.filter((item) => item.category_id === category.id)}
            categories={data.categories}
            viewDay={day}
            onAdd={(values) => add(category, values)}
            onToggle={(item) => void toggle(item)}
            onDone={done}
          />
        ))}
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
  friendId = null,
  onFriend,
  onFriends,
}: {
  day: string;
  name: string;
  onDay: (day: string) => void;
  /** 머리의 'TODO'을 누르면 서버 목록으로 */
  onServers: () => void;
  version?: number;
  /** 보고 있는 친구(없으면 나) */
  friendId?: string | null;
  onFriend?: (id: string | null) => void;
  onFriends?: () => void;
}) {
  const [friends, setFriends] = useState<(TodoPerson & { done: number; total: number })[]>([]);
  useEffect(() => {
    let stopped = false;
    fetchFriendsToday(isDayKey(day) ? day : today())
      .then((value) => !stopped && setFriends(value.friends))
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [day, version]);
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
      <header className="room-header todo-header">
        <div className="room-title">
          <button type="button" className="todo-side-switch" onClick={onServers} aria-label="서버 목록 보기">
            <strong>TODO</strong>
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
          <button
            type="button"
            className={friendId === null ? "list-item list-item-active todo-person" : "list-item todo-person"}
            onClick={() => onFriend?.(null)}
          >
            <span className="todo-person-name">{name}</span>
            <span className="list-sub">{mine ? `${mine.done}/${mine.total}` : "0/0"}</span>
          </button>
          {friends.map((friend) => (
            <button
              key={friend.id}
              type="button"
              className={friendId === friend.id ? "list-item list-item-active todo-person" : "list-item todo-person"}
              onClick={() => onFriend?.(friend.id)}
            >
              <span className="todo-person-name">{friend.name}</span>
              <span className="list-sub">{`${friend.done}/${friend.total}`}</span>
            </button>
          ))}
          {onFriends && (
            <button type="button" className="list-item todo-friends-link" onClick={onFriends}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="9" cy="8" r="3.2" />
                <path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" />
                <path d="M16 5.2a3 3 0 0 1 0 5.6M17.5 14.3c1.7.6 2.7 2.2 3 4.7" />
              </svg>
              <span className="todo-person-name">친구 관리</span>
              <svg className="todo-friends-chevron" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 6l6 6-6 6" />
              </svg>
            </button>
          )}
        </section>
      </div>
    </div>
  );
}

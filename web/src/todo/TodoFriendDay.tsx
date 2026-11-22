// 친구 TODO 보기(SCR-05): 읽기만. 내가 볼 수 있는 카테고리(친구: 전체와 친구, 같은 서버: 전체)만 오고,
// 메모는 '메모도 보여 주기'인 카테고리만. TODO마다 반응을 달 수 있다
import { type ReactNode, useEffect, useState } from "react";
import BackIcon from "../BackIcon";
import SplitToggle from "../SplitToggle";
import { viaServer } from "../format";
import { addDays, longLabel, timeLabel, today } from "./dates";
import { CategoryDot, CHECK_PATH, checkStyle, MemoText, repeatLabel } from "./TodoItems";
import { TodoReactions } from "./TodoReactions";
import { type FriendDay, fetchFriendDay, type TodoItem, type TodoReaction } from "./todoApi";
import "./todo.css";

function FriendRow({ owner, item, color }: { owner: string; item: TodoItem; color: string }) {
  const [reactions, setReactions] = useState<TodoReaction[]>(item.reactions ?? []);
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
        <span
          className={item.done ? "todo-check todo-check-on todo-check-readonly" : "todo-check todo-check-readonly"}
          style={checkStyle(color)}
          aria-label={item.done ? "했어요" : "아직"}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d={CHECK_PATH} />
          </svg>
        </span>
        <span className="todo-title todo-title-readonly">
          <span className="todo-title-text">{item.title}</span>
          {meta && <span className="todo-meta">{meta}</span>}
        </span>
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
      {memoOpen && item.memo && <MemoText text={item.memo} />}
      <TodoReactions owner={owner} itemId={item.id} reactions={reactions} canAdd onChange={setReactions} />
    </li>
  );
}

export default function TodoFriendDay({
  friendId,
  day,
  onDay,
  showBack,
  onBack,
  menu,
}: {
  friendId: string;
  day: string;
  onDay: (day: string) => void;
  showBack: boolean;
  onBack: () => void;
  menu: ReactNode;
}) {
  const [data, setData] = useState<FriendDay | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let stopped = false;
    setData(null);
    setFailed(false);
    fetchFriendDay(friendId, day)
      .then((value) => !stopped && setData(value))
      .catch(() => !stopped && setFailed(true));
    return () => {
      stopped = true;
    };
  }, [friendId, day]);
  const name = data?.person?.name ?? "";
  const done = data?.items.filter((item) => item.done).length ?? 0;
  return (
    <div className="room todo-room">
      <header className="room-header todo-header">
        <SplitToggle />
        {showBack && (
          <button type="button" className="back-button" onClick={onBack} aria-label="내 TODO로">
            <BackIcon />
          </button>
        )}
        {data?.person?.avatar_url && (
          <img className="todo-friend-avatar" src={viaServer(data.person.avatar_url)} alt="" referrerPolicy="no-referrer" />
        )}
        <div className="room-title">
          <strong>{name ? `${name}의 TODO` : "친구 TODO"}</strong>
          <span className="room-sub">
            {longLabel(day)}
            {data ? `, ${done}/${data.items.length}` : ""}
            {data?.relation === "server" ? ", 같은 서버(전체 공개만)" : ""}
          </span>
        </div>
        <div className="header-tools">
          <button type="button" className="header-tool" aria-label="전날" onClick={() => onDay(addDays(day, -1))}>
            <BackIcon />
          </button>
          {day !== today() && (
            <button type="button" className="header-tool" onClick={() => onDay(today())}>
              <span className="header-tool-label todo-tool-always">오늘</span>
            </button>
          )}
          <button type="button" className="header-tool todo-next-day" aria-label="다음 날" onClick={() => onDay(addDays(day, 1))}>
            <BackIcon />
          </button>
        </div>
        {menu}
      </header>
      <div className="todo-body">
        {failed && <p className="list-note">볼 수 없는 친구예요. 친구를 끊었거나 같은 서버에 없어요.</p>}
        {!failed && data === null && <p className="list-note">불러오는 중…</p>}
        {data && data.items.length === 0 && <p className="list-note">이날 보여 준 TODO가 없어요.</p>}
        {data?.categories.map((category) => {
          const mine = data.items.filter((item) => item.category_id === category.id);
          if (mine.length === 0) return null;
          return (
            <section key={category.id} className="todo-block" aria-label={category.name}>
              <h2 className="todo-cat">
                <CategoryDot color={category.color} />
                {category.name}
              </h2>
              <ul className="todo-list">
                {mine.map((item) => (
                  <FriendRow key={item.id} owner={friendId} item={item} color={category.color} />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

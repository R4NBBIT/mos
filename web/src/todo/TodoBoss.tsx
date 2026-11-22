// 위장 화면 '내 TODO'(SCR-11, BOSS-01~05): 진짜 오늘 TODO를 지금 테마의 프로그램 모양으로.
// 체크와 빈 줄에 쓰기는 실제로 저장된다. 친구, 반응, AI 표시, 카테고리 색은 보이지 않는다.
// 잠겨서 받지 못하면 이 탭이 마지막으로 받은 목록(메모리에만)을 보여 주고 고칠 수 없게 한다.
import { useCallback, useEffect, useRef, useState } from "react";
import WordChrome from "../WordChrome";
import type { Theme } from "../theme";
import { longLabel, today } from "./dates";
import { useEnterKey } from "./enterKey";
import { addTodo, fetchTodoDay, type TodoDay, type TodoItem, updateTodo } from "./todoApi";
import { todoBossTitle } from "./feature";
import "./todo.css";

let lastDay: TodoDay | null = null; // 이 탭 메모리에만(브라우저 저장소에는 남기지 않음)

const SHEET_ROWS = 24;

function useBossDay(active: boolean): { data: TodoDay | null; offline: boolean; reload: () => void; setData: (d: TodoDay) => void } {
  const [data, setData] = useState<TodoDay | null>(lastDay);
  const [offline, setOffline] = useState(false);
  const reload = useCallback(() => {
    fetchTodoDay(today())
      .then((value) => {
        lastDay = value;
        setData(value);
        setOffline(false);
      })
      .catch(() => setOffline(true));
  }, []);
  useEffect(() => {
    if (active) reload();
  }, [active, reload]);
  return {
    data,
    offline,
    reload,
    setData: (value) => {
      lastDay = value;
      setData(value);
    },
  };
}

function AddLine({ disabled, onAdd, className, placeholder }: { disabled: boolean; onAdd: (title: string) => Promise<void>; className: string; placeholder: string }) {
  const [text, setText] = useState("");
  const ref = useRef(text);
  ref.current = text;
  const enter = useEnterKey(() => {
    const value = ref.current.trim();
    if (!value) return;
    void onAdd(value).then(() => setText(""));
  });
  return (
    <input
      className={className}
      value={text}
      maxLength={100}
      disabled={disabled}
      placeholder={placeholder}
      aria-label="TODO 입력"
      onChange={(event) => setText(event.target.value)}
      {...enter}
    />
  );
}

export default function TodoBoss({ theme, active }: { theme: Theme; active: boolean }) {
  const { data, offline, reload, setData } = useBossDay(active);
  const title = todoBossTitle(theme);
  const categories = data?.categories ?? [];
  const firstOpen = categories.find((category) => !category.closed);
  const nameOf = (id: string) => categories.find((category) => category.id === id)?.name ?? "";
  const items = data?.items ?? [];

  const toggle = async (item: TodoItem) => {
    if (!data || offline) return;
    const flipped = { ...item, done: !item.done };
    setData({ ...data, items: data.items.map((it) => (it.id === item.id ? flipped : it)) });
    try {
      const saved = await updateTodo(item.id, { done: flipped.done });
      if (lastDay) setData({ ...lastDay, items: lastDay.items.map((it) => (it.id === item.id ? saved : it)) });
    } catch {
      reload();
    }
  };
  const add = async (value: string) => {
    if (!firstOpen || offline) return;
    try {
      await addTodo({ title: value, day: today(), category_id: firstOpen.id });
    } finally {
      reload();
    }
  };
  const locked = offline || !firstOpen;
  const check = (item: TodoItem) => (
    <button
      type="button"
      className={item.done ? "boss-todo-box boss-todo-box-on" : "boss-todo-box"}
      aria-pressed={item.done}
      aria-label={`${item.title} 완료`}
      disabled={offline}
      onClick={() => void toggle(item)}
    />
  );

  if (theme === "sheet") {
    const columns = ["A", "B", "C", "D", "E"];
    const empty = Math.max(SHEET_ROWS - items.length - 2, 3);
    return (
      <div className="boss-todo boss-todo-sheet">
        <div className="boss-todo-sheetbar">{title.name}</div>
        <div className="boss-todo-sheetmenu">
          {["파일", "홈", "삽입", "수식", "데이터", "보기"].map((menu) => (
            <span key={menu}>{menu}</span>
          ))}
        </div>
        <div className="boss-todo-grid" role="table" aria-label="TODO">
          <div className="boss-todo-cell boss-todo-head" />
          {columns.map((col) => (
            <div key={col} className="boss-todo-cell boss-todo-head">
              {col}
            </div>
          ))}
          <div className="boss-todo-cell boss-todo-num">1</div>
          {["완료", "TODO", "구분", "시각", "장소"].map((head) => (
            <div key={head} className="boss-todo-cell boss-todo-title">
              {head}
            </div>
          ))}
          {items.map((item, index) => (
            <div key={item.id} className="boss-todo-row" role="row">
              <div className="boss-todo-cell boss-todo-num">{index + 2}</div>
              <div className="boss-todo-cell boss-todo-center">{check(item)}</div>
              <div className="boss-todo-cell">{item.title}</div>
              <div className="boss-todo-cell">{nameOf(item.category_id)}</div>
              <div className="boss-todo-cell">{item.time ?? ""}</div>
              <div className="boss-todo-cell">{item.place ?? ""}</div>
            </div>
          ))}
          <div className="boss-todo-cell boss-todo-num">{items.length + 2}</div>
          <div className="boss-todo-cell" />
          <div className="boss-todo-cell">
            <AddLine disabled={locked} onAdd={add} className="boss-todo-input" placeholder="" />
          </div>
          <div className="boss-todo-cell" />
          <div className="boss-todo-cell" />
          <div className="boss-todo-cell" />
          {Array.from({ length: empty }, (_, index) => (
            <div key={`e${index}`} className="boss-todo-row">
              <div className="boss-todo-cell boss-todo-num">{items.length + 3 + index}</div>
              {columns.map((col) => (
                <div key={col} className="boss-todo-cell" />
              ))}
            </div>
          ))}
        </div>
        <div className="boss-todo-tabs">
          <span className="boss-todo-tab-on">{longLabel(today()).replace(/ \S+요일$/, "")}</span>
          <span>이번 달</span>
        </div>
      </div>
    );
  }

  if (theme === "memo") {
    return (
      <div className="boss-todo boss-todo-memo">
        <div className="boss-todo-memobar">{title.name}</div>
        <div className="boss-todo-memomenu">
          {["파일", "편집", "서식", "보기", "도움말"].map((menu) => (
            <span key={menu}>{menu}</span>
          ))}
        </div>
        <div className="boss-todo-memobody">
          {categories.map((category) => {
            const mine = items.filter((item) => item.category_id === category.id);
            if (mine.length === 0) return null;
            return (
              <div key={category.id}>
                <div>== {category.name} ==</div>
                {mine.map((item) => (
                  <div key={item.id} className="boss-todo-memoline">
                    <button type="button" className="boss-todo-memocheck" disabled={offline} onClick={() => void toggle(item)}>
                      {item.done ? "[✓]" : "[ ]"}
                    </button>{" "}
                    {item.title}
                    {item.time ? `  ${item.time}` : ""}
                    {item.place ? ` @${item.place}` : ""}
                  </div>
                ))}
                <div>&nbsp;</div>
              </div>
            );
          })}
          <AddLine disabled={locked} onAdd={add} className="boss-todo-memoinput" placeholder="" />
        </div>
      </div>
    );
  }

  const list = (
    <>
      {categories.map((category) => {
        const mine = items.filter((item) => item.category_id === category.id);
        if (mine.length === 0) return null;
        return (
          <section key={category.id} className="boss-todo-section">
            <h2>{category.name}</h2>
            {mine.map((item) => (
              <div key={item.id} className={item.done ? "boss-todo-item boss-todo-item-done" : "boss-todo-item"}>
                {check(item)}
                <span>{item.title}</span>
                {(item.time || item.place) && <small>{[item.time, item.place ?? ""].filter(Boolean).join(" | ")}</small>}
              </div>
            ))}
          </section>
        );
      })}
      <div className="boss-todo-item">
        <span className="boss-todo-box boss-todo-box-ghost" aria-hidden="true" />
        <AddLine disabled={locked} onAdd={add} className="boss-todo-docinput" placeholder="TODO" />
      </div>
    </>
  );

  if (theme === "word") {
    return (
      <div className="boss-todo boss-todo-word word-app">
        <WordChrome name={title.name} />
        <div className="boss-todo-paperwrap">
          <article className="boss-todo-paper">
            <h1>{longLabel(today())} TODO</h1>
            {list}
          </article>
        </div>
      </div>
    );
  }

  return (
    <div className="boss-todo boss-todo-note">
      <article className="boss-todo-page">
        <p className="boss-todo-crumb">업무 공간 / TODO</p>
        <h1>{longLabel(today())}</h1>
        {list}
      </article>
    </div>
  );
}

// 할 일 위젯(T5, WIDGET): 오늘 할 일만 작게. 체크와 빠른 추가.
// PC: 크롬, 엣지는 '항상 위' 작은 창(Document Picture-in-Picture), 없으면 작은 팝업 창(#/todo/widget).
// 위장(보스키)이 켜지면 위젯 창도 같이 닫힌다. 테마는 지금 ㅁㅇㅅ 테마 그대로.
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { isDisguised, onDisguiseChange } from "../boss/bossState";
import { dateWithWeekday, timeLabel, today } from "./dates";
import { useEnterKey } from "./enterKey";
import { CategoryDot, CHECK_PATH } from "./TodoItems";
import { addTodo, fetchTodoDay, type TodoDay, type TodoItem, updateTodo } from "./todoApi";
import "./todo.css";

const REFRESH_MS = 60_000;

export default function TodoWidget({ compact = false }: { compact?: boolean }) {
  const [data, setData] = useState<TodoDay | null>(null);
  const [day, setDay] = useState(today());
  const [text, setText] = useState("");
  const [failed, setFailed] = useState(false);
  const textRef = useRef(text);
  textRef.current = text;

  const load = useCallback(() => {
    const now = today();
    setDay(now);
    fetchTodoDay(now)
      .then((value) => {
        setData(value);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);
  useEffect(() => {
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const toggle = async (item: TodoItem) => {
    if (!data) return;
    setData({ ...data, items: data.items.map((it) => (it.id === item.id ? { ...it, done: !it.done } : it)) });
    try {
      await updateTodo(item.id, { done: !item.done });
    } finally {
      load();
    }
  };
  const first = data?.categories.find((category) => !category.closed);
  const add = useEnterKey(() => {
    const title = textRef.current.trim();
    if (!title || !first) return;
    setText("");
    void addTodo({ title, day, category_id: first.id }).finally(load);
  });

  const items = data?.items ?? [];
  const done = items.filter((item) => item.done).length;
  return (
    <div className={compact ? "todo-widget todo-widget-compact" : "todo-widget"}>
      <header className="todo-widget-head">
        <strong>{dateWithWeekday(day)}</strong>
        <span>
          {done}/{items.length}
        </span>
      </header>
      {failed && <p className="todo-setting-help">불러오지 못했어요. ㅁㅇㅅ가 잠겼으면 잠금을 풀어 주세요.</p>}
      <ul className="todo-widget-list">
        {items.map((item) => {
          const category = data?.categories.find((c) => c.id === item.category_id);
          return (
            <li key={item.id} className={item.done ? "todo-widget-item todo-row-done" : "todo-widget-item"}>
              <button
                type="button"
                className={item.done ? "todo-check todo-check-on" : "todo-check"}
                aria-pressed={item.done}
                aria-label={`${item.title} ${item.done ? "완료 취소" : "완료"}`}
                onClick={() => void toggle(item)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d={CHECK_PATH} />
                </svg>
              </button>
              {category && <CategoryDot color={category.color} />}
              <span className="todo-title-text">{item.title}</span>
              {item.time && <span className="todo-meta">{timeLabel(item.time)}</span>}
            </li>
          );
        })}
      </ul>
      {data && items.length === 0 && <p className="todo-setting-help">오늘 할 일이 없어요.</p>}
      {first && (
        <div className="todo-add todo-widget-add">
          <span className="todo-check todo-check-ghost todo-add-plus" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </span>
          <input
            className="todo-add-input"
            value={text}
            maxLength={100}
            aria-label={`${first.name}에 할 일 넣기`}
            onChange={(event) => setText(event.target.value)}
            {...add}
          />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ 위젯 창 열기

interface PipApi {
  requestWindow(options: { width: number; height: number }): Promise<Window>;
  window: Window | null;
}

function pipApi(): PipApi | null {
  const api = (window as unknown as { documentPictureInPicture?: PipApi }).documentPictureInPicture;
  return api ?? null;
}

/** 이 브라우저가 '항상 위' 위젯 창을 지원하는지 */
export function canFloat(): boolean {
  return pipApi() !== null;
}

/** 위젯 창 열기. 지원하면 항상 위 작은 창, 아니면 작은 팝업 창 */
export async function openTodoWidget(): Promise<void> {
  if (isDisguised()) return;
  const api = pipApi();
  if (!api) {
    window.open("/#/todo/widget", "mos-todo-widget", "popup,width=340,height=520");
    return;
  }
  if (api.window) {
    api.window.focus();
    return;
  }
  const pip = await api.requestWindow({ width: 320, height: 460 });
  // 지금 화면의 스타일과 테마를 그대로 옮긴다
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const css = Array.from(sheet.cssRules)
        .map((rule) => rule.cssText)
        .join("\n");
      const style = pip.document.createElement("style");
      style.textContent = css;
      pip.document.head.appendChild(style);
    } catch {
      if (sheet.href) {
        const link = pip.document.createElement("link");
        link.rel = "stylesheet";
        link.href = sheet.href;
        pip.document.head.appendChild(link);
      }
    }
  }
  for (const attribute of Array.from(document.documentElement.attributes)) {
    if (attribute.name.startsWith("data-") || attribute.name === "style") {
      pip.document.documentElement.setAttribute(attribute.name, attribute.value);
    }
  }
  pip.document.title = "할 일";
  pip.document.body.className = "todo-widget-body";
  // 위젯 창에서 누른 보스키도 본 창이 받게
  pip.document.addEventListener("keydown", (event) => {
    window.dispatchEvent(new KeyboardEvent("keydown", event));
  });
  const holder = pip.document.createElement("div");
  pip.document.body.appendChild(holder);
  const root = createRoot(holder);
  root.render(<TodoWidget compact />);
  const stop = onDisguiseChange((value) => {
    if (value) pip.close(); // 위장하면 위젯 창도 바로 닫는다
  });
  pip.addEventListener("pagehide", () => {
    stop();
    root.unmount();
  });
}

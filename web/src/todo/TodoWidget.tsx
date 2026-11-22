// 할 일 위젯(T5, WIDGET): 오늘 할 일만 작게. 체크와 빠른 추가.
// PC: 따로 뜨는 작은 창(#/todo/widget)이라 ㅁㅇㅅ 탭을 닫아도 남는다(2026-11-22 사용자 요청).
// 크롬, 엣지는 그 창에서 '항상 위'(Document Picture-in-Picture)를 켤 수 있다.
// 어느 창에서든 위장(보스키)하면 위젯 창도 같이 닫힌다. 테마마다 그 프로그램 모양(TodoWidgetLooks).
// 본 화면과 위젯 창은 서로 바꾼 것을 바로 알린다(todoSync).
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { isDisguised, onDisguiseChange } from "../boss/bossState";
import { today } from "./dates";
import { useEnterKey } from "./enterKey";
import { onTodoRefresh, onTodoSync } from "./todoSync";
import { type WidgetModel, WidgetLook, widgetLook } from "./TodoWidgetLooks";
import { addTodo, fetchTodoDay, type TodoDay, type TodoItem, updateTodo } from "./todoApi";
import "./todo.css";

const REFRESH_MS = 15_000;

export default function TodoWidget({ compact = false, theme }: { compact?: boolean; theme?: string }) {
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
    if (!compact) document.title = "TODO";
  }, [compact]);
  useEffect(() => {
    load();
    return onTodoRefresh(load, REFRESH_MS); // 다른 창에서 바꾸면 바로, 다른 기기는 15초마다
  }, [load]);
  // 따로 뜬 위젯 창: 어느 창에서든 위장하면 닫는다
  useEffect(() => {
    if (compact) return;
    const hide = () => {
      pipApi()?.window?.close();
      window.close();
    };
    const stopSync = onTodoSync((message) => {
      if (message === "disguise") hide();
    });
    const stopOwn = onDisguiseChange((value) => {
      if (value) hide();
    });
    return () => {
      stopSync();
      stopOwn();
    };
  }, [compact]);

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

  const items = [...(data?.items ?? [])].sort(
    (a, b) => Number(a.done) - Number(b.done) || (a.time ?? "99").localeCompare(b.time ?? "99"),
  );
  const colors = new Map((data?.categories ?? []).map((category) => [category.id, category.color]));
  const model: WidgetModel = {
    day,
    items,
    done: items.filter((item) => item.done).length,
    colorOf: (item) => colors.get(item.category_id),
    onToggle: (item) => void toggle(item),
    note: failed
      ? "불러오지 못했어요. ㅁㅇㅅ가 잠겼으면 잠금을 풀어 주세요."
      : data && items.length === 0
        ? "오늘 할 일이 없어요."
        : null,
    add: first
      ? {
          value: text,
          maxLength: 100,
          "aria-label": `${first.name}에 할 일 넣기`,
          onChange: (event) => setText(event.target.value),
          ...add,
        }
      : null,
  };
  const look = widgetLook(theme ?? document.documentElement.dataset.theme);
  return (
    <div className={`todo-widget tw-${look}${compact ? " todo-widget-compact" : ""}`}>
      <WidgetLook look={look} model={model} />
      {!compact && canFloat() && <FloatBar />}
    </div>
  );
}

/** 따로 뜬 위젯 창 아래: 항상 위 창 켜고 끄기 */
function FloatBar() {
  const [floating, setFloating] = useState(Boolean(pipApi()?.window));
  return (
    <div className="tw-float">
      {floating ? (
        <>
          <span className="tw-grow">항상 위 창을 띄웠어요. 이 창은 최소화해 두세요(닫으면 같이 닫혀요).</span>
          <button
            type="button"
            onClick={() => {
              pipApi()?.window?.close();
              setFloating(false);
            }}
          >
            닫기
          </button>
        </>
      ) : (
        <button
          type="button"
          className="tw-float-on"
          onClick={() => void openFloating(() => setFloating(false)).then((ok) => setFloating(ok))}
        >
          항상 위에 띄우기
        </button>
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

/** 위젯 창 열기: 따로 뜨는 작은 창(ㅁㅇㅅ 탭을 닫아도 남음) */
export function openTodoWidget(): void {
  if (isDisguised()) return;
  const opened = window.open("/#/todo/widget", "mos-todo-widget", "popup,width=340,height=560");
  opened?.focus();
}

/** 이 창(따로 뜬 위젯 창)에서 항상 위 창 띄우기. 띄웠으면 true */
async function openFloating(onClosed: () => void): Promise<boolean> {
  const api = pipApi();
  if (!api || isDisguised()) return false;
  if (api.window) {
    api.window.focus();
    return true;
  }
  const pip = await api.requestWindow({ width: 320, height: 460 });
  // 지금 화면의 스타일과 테마를 그대로 옮긴다. 배포 서버는 CSP(style-src 'self')라 글자로 넣은
  // <style>은 막히므로, 파일로 된 스타일은 같은 주소의 <link>로 붙인다(개발 서버만 글자로).
  for (const sheet of Array.from(document.styleSheets)) {
    if (sheet.href) {
      const link = pip.document.createElement("link");
      link.rel = "stylesheet";
      link.href = sheet.href;
      pip.document.head.appendChild(link);
      continue;
    }
    try {
      const style = pip.document.createElement("style");
      style.textContent = Array.from(sheet.cssRules)
        .map((rule) => rule.cssText)
        .join("\n");
      pip.document.head.appendChild(style);
    } catch {
      // 읽을 수 없는 스타일은 건너뜀
    }
  }
  for (const attribute of Array.from(document.documentElement.attributes)) {
    if (attribute.name.startsWith("data-")) {
      pip.document.documentElement.setAttribute(attribute.name, attribute.value);
    }
  }
  pip.document.documentElement.style.cssText = document.documentElement.style.cssText;
  pip.document.title = "TODO";
  pip.document.body.className = "todo-widget-body";
  // 위젯 창에서 누른 보스키도 본 창이 받게
  pip.document.addEventListener("keydown", (event) => {
    window.dispatchEvent(new KeyboardEvent("keydown", event));
  });
  const holder = pip.document.createElement("div");
  pip.document.body.appendChild(holder);
  const root = createRoot(holder);
  root.render(<TodoWidget compact theme={document.documentElement.dataset.theme} />);
  const stop = onDisguiseChange((value) => {
    if (value) pip.close(); // 위장하면 위젯 창도 바로 닫는다
  });
  pip.addEventListener("pagehide", () => {
    stop();
    root.unmount();
    onClosed();
  });
  return true;
}

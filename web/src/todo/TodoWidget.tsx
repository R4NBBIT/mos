// TODO 위젯(T5, WIDGET): 오늘 TODO만 작게 보고 체크만 한다. 넣기와 삭제는 앱이나 AI에서만(2026-11-23 사용자 요청).
// PC: 따로 뜨는 작은 창(#/todo/widget)이라 ㅁㅇㅅ 탭을 닫아도 남는다(2026-11-22 사용자 요청).
// 크롬, 엣지는 '항상 위에 띄우기'로 위젯 자체를 항상 위 창(Document Picture-in-Picture)으로 옮긴다.
// 원래 창은 작게 줄여 두고, '되돌아가기'를 누르면 위젯이 원래 창으로 돌아온다(원래 창을 닫으면 같이 닫힘).
// 어느 창에서든 위장(보스키)하면 위젯 창도 같이 닫힌다. 테마마다 그 프로그램 모양(TodoWidgetLooks).
// 본 화면과 위젯 창은 서로 바꾼 것을 바로 알린다(todoSync).
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isDisguised, onDisguiseChange } from "../boss/bossState";
import { today } from "./dates";
import { onTodoRefresh, onTodoSync } from "./todoSync";
import { type WidgetModel, WidgetLook, widgetLook } from "./TodoWidgetLooks";
import { fetchTodoDay, type TodoDay, type TodoItem, updateTodo } from "./todoApi";
import { saveWidgetCategories, useWidgetCategories } from "./widgetFilter";
import "./todo.css";

const REFRESH_MS = 15_000;

export default function TodoWidget({ compact = false, theme }: { compact?: boolean; theme?: string }) {
  const [data, setData] = useState<TodoDay | null>(null);
  const [day, setDay] = useState(today());
  const [failed, setFailed] = useState(false);
  // 항상 위 창으로 옮겼을 때 그 창(위젯은 그 창 안에 그린다)
  const [floatWindow, setFloatWindow] = useState<Window | null>(null);
  // 이 기기 위젯에 보일 카테고리(빈 목록 = 모두)
  const chosen = useWidgetCategories();
  const [picking, setPicking] = useState(false);

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

  const openCategories = (data?.categories ?? []).filter((category) => !category.closed);
  const known = chosen.filter((id) => openCategories.some((category) => category.id === id));
  // 순서는 TODO 화면 그대로: 카테고리 순서, 그 안에서는 사용자가 정한 순서(시각, 완료로 다시 줄 세우지 않음)
  const rank = new Map((data?.categories ?? []).map((category, index) => [category.id, index]));
  const items = (data?.items ?? [])
    .filter((item) => known.length === 0 || known.includes(item.category_id))
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (rank.get(a.item.category_id) ?? 999) - (rank.get(b.item.category_id) ?? 999) || a.index - b.index)
    .map(({ item }) => item);
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
        ? known.length > 0
          ? "고른 카테고리에 오늘 TODO가 없어요."
          : "오늘 TODO가 없어요."
        : null,
  };
  const look = widgetLook(theme ?? document.documentElement.dataset.theme);
  const sizeRef = useRef<{ width: number; height: number } | null>(null);
  const float = async () => {
    const pip = await openFloating(() => {
      setFloatWindow(null);
      // 되돌아가면 원래 창 크기로
      const size = sizeRef.current;
      if (size) window.resizeTo(size.width, size.height);
      window.focus();
    });
    if (!pip) return;
    sizeRef.current = { width: window.outerWidth, height: window.outerHeight };
    setFloatWindow(pip);
    window.resizeTo(300, 150); // 원래 창은 작게 줄여 둔다(닫으면 항상 위 창도 닫혀서 닫지는 않는다)
  };
  const widget = (
    <div className={`todo-widget tw-${look}${compact ? " todo-widget-compact" : ""}`}>
      <WidgetLook look={look} model={model} />
      {!compact && picking && (
        <div className="tw-pick" role="group" aria-label="위젯에 보일 카테고리">
          <p className="tw-pick-note">이 기기 위젯에만 적용돼요. 아무것도 고르지 않으면 모두 보여요.</p>
          {openCategories.map((category) => (
            <label key={category.id} className="tw-pick-row">
              <input
                type="checkbox"
                checked={known.includes(category.id)}
                onChange={(event) =>
                  saveWidgetCategories(
                    event.target.checked ? [...known, category.id] : known.filter((id) => id !== category.id),
                  )
                }
              />
              <span>{category.name}</span>
            </label>
          ))}
        </div>
      )}
      {!compact && (
        <div className="tw-float">
          <button type="button" aria-expanded={picking} onClick={() => setPicking(!picking)}>
            {picking ? "닫기" : known.length > 0 ? `카테고리 ${known.length}개만` : "카테고리"}
          </button>
          {!canFloat() ? null : floatWindow ? (
            <button type="button" onClick={() => floatWindow.close()}>
              되돌아가기
            </button>
          ) : (
            <button type="button" onClick={() => void float()}>
              항상 위에 띄우기
            </button>
          )}
        </div>
      )}
    </div>
  );
  if (floatWindow) {
    return (
      <>
        <div className="tw-floating-note">
          <p>위젯이 항상 위 창에 떠 있어요. 이 창을 닫으면 같이 닫혀요.</p>
          <button type="button" className="todo-small-button" onClick={() => floatWindow.close()}>
            되돌아가기
          </button>
        </div>
        {createPortal(widget, floatWindow.document.body)}
      </>
    );
  }
  return widget;
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

/** 이 창(따로 뜬 위젯 창)에서 항상 위 창 열기. 위젯은 부르는 쪽이 그 안에 그린다 */
async function openFloating(onClosed: () => void): Promise<Window | null> {
  const api = pipApi();
  if (!api || isDisguised()) return null;
  if (api.window) {
    api.window.focus();
    return api.window;
  }
  let pip: Window;
  try {
    pip = await api.requestWindow({
      width: Math.max(280, window.innerWidth),
      height: Math.max(360, window.innerHeight),
    });
  } catch {
    return null;
  }
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
  const stop = onDisguiseChange((value) => {
    if (value) pip.close(); // 위장하면 위젯 창도 바로 닫는다
  });
  pip.addEventListener("pagehide", () => {
    stop();
    onClosed();
  });
  return pip;
}

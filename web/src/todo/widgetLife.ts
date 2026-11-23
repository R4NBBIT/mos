// TODO 위젯 창을 ㅁㅇㅅ(웹, 웹앱) 창을 모두 닫을 때 같이 닫을지(이 기기에서만, 2026-11-23 사용자 요청).
// 기본은 남겨 두기. 같이 닫기를 고르면: 본 창이 닫힐 때 '닫혀요'를 알리고, 위젯 창은 다른 본 창이
// 남아 있는지 물어본 뒤 아무도 답하지 않으면 스스로 닫는다(항상 위 창도 같이 닫힘).
import { useEffect, useState } from "react";

const KEY = "mos.todo.widget.closeWithApp";
const EVENT = "mos-widget-close-with-app";
const CHANNEL = "mos-app-presence";
const WIDGET_HASH = "#/todo/widget";
const ASK_AFTER_MS = 600; // 새로고침이면 그사이 다시 열린다
const WAIT_REPLY_MS = 700;

type PresenceMessage = "bye" | "ping" | "alive";

export function readCloseWithApp(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function saveCloseWithApp(value: boolean): void {
  try {
    if (value) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    // 저장을 못 해도 지금 창에는 적용한다
  }
  window.dispatchEvent(new Event(EVENT));
}

export function useCloseWithApp(): boolean {
  const [value, setValue] = useState(readCloseWithApp);
  useEffect(() => {
    const update = () => setValue(readCloseWithApp());
    const onStorage = (event: StorageEvent) => {
      if (event.key === KEY || event.key === null) update();
    };
    window.addEventListener(EVENT, update);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT, update);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return value;
}

const isWidget = () => window.location.hash === WIDGET_HASH;

/** 본 창(위젯 창 말고): 물으면 '있어요', 닫힐 때 '닫혀요' */
export function startAppPresence(): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const channel = new BroadcastChannel(CHANNEL);
  const onMessage = (event: MessageEvent<PresenceMessage>) => {
    if (event.data === "ping" && !isWidget()) channel.postMessage("alive" satisfies PresenceMessage);
  };
  const onHide = () => {
    if (!isWidget()) channel.postMessage("bye" satisfies PresenceMessage);
  };
  channel.addEventListener("message", onMessage);
  window.addEventListener("pagehide", onHide);
  return () => {
    channel.removeEventListener("message", onMessage);
    window.removeEventListener("pagehide", onHide);
    channel.close();
  };
}

/** 위젯 창: 같이 닫기를 골랐으면 본 창이 모두 닫혔을 때 스스로 닫는다 */
export function useCloseWhenAppCloses(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(CHANNEL);
    let alive = false;
    let timers: number[] = [];
    const onMessage = (event: MessageEvent<PresenceMessage>) => {
      if (event.data === "alive") alive = true;
      if (event.data !== "bye") return;
      timers.forEach((timer) => window.clearTimeout(timer));
      timers = [
        window.setTimeout(() => {
          alive = false;
          channel.postMessage("ping" satisfies PresenceMessage);
          timers.push(
            window.setTimeout(() => {
              if (!alive) window.close();
            }, WAIT_REPLY_MS),
          );
        }, ASK_AFTER_MS),
      ];
    };
    channel.addEventListener("message", onMessage);
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      channel.removeEventListener("message", onMessage);
      channel.close();
    };
  }, [enabled]);
}

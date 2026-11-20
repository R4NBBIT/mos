import { useEffect, useRef } from "react";
import type { RealtimeEvent } from "./types";

const PING_INTERVAL_MS = 30_000;
const MAX_RETRY_MS = 30_000;

interface Handlers {
  onEvent: (event: RealtimeEvent) => void;
  /** 처음 연결·다시 연결될 때. 끊긴 사이 메시지를 다시 받아 오는 데 쓴다 */
  onConnected: () => void;
  onStatus: (connected: boolean) => void;
}

/** /ws 에 붙어 실시간 이벤트를 받는다. 끊기면 1초→2초→…→30초 간격으로 다시 붙는다. */
export function useRealtime(enabled: boolean, handlers: Handlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    let socket: WebSocket | null = null;
    let retryMs = 1000;
    let retryTimer: number | undefined;
    let pingTimer: number | undefined;
    let stopped = false;

    const connect = () => {
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${scheme}://${window.location.host}/ws`);

      socket.onopen = () => {
        retryMs = 1000;
        handlersRef.current.onStatus(true);
        handlersRef.current.onConnected();
        pingTimer = window.setInterval(() => socket?.send("ping"), PING_INTERVAL_MS);
      };
      socket.onmessage = (message) => {
        if (typeof message.data !== "string" || message.data === "pong") return;
        try {
          handlersRef.current.onEvent(JSON.parse(message.data) as RealtimeEvent);
        } catch {
          // 알 수 없는 형식은 무시
        }
      };
      socket.onclose = () => {
        window.clearInterval(pingTimer);
        handlersRef.current.onStatus(false);
        if (stopped) return;
        retryTimer = window.setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
      };
    };

    connect();
    return () => {
      stopped = true;
      window.clearTimeout(retryTimer);
      window.clearInterval(pingTimer);
      socket?.close();
    };
  }, [enabled]);
}

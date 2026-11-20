import { useEffect, useRef } from "react";
import type { RealtimeEvent } from "./types";

const PING_INTERVAL_MS = 30_000;
const MAX_RETRY_MS = 30_000;
const POLICY_VIOLATION = 1008;

interface Handlers {
  onEvent: (event: RealtimeEvent) => void;
  /** 처음 연결·다시 연결될 때. 끊긴 사이 메시지를 다시 받아 오는 데 쓴다 */
  onConnected: () => void;
  onStatus: (connected: boolean) => void;
  /** 서버가 연결을 거절함(잠김·계정 바뀜). 다시 붙지 않는다 */
  onRejected: () => void;
}

/**
 * /ws 에 붙어, 보고 있는 채널(channelId)의 실시간 이벤트만 받는다.
 * 끊기면 1초→2초→…→30초 간격으로 다시 붙고, 붙을 때마다 채널을 다시 알린다.
 */
export function useRealtime(channelId: string | null, handlers: Handlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const channelRef = useRef(channelId);
  const socketRef = useRef<WebSocket | null>(null);
  const enabled = channelId !== null;

  const sendSubscribe = (socket: WebSocket | null) => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "subscribe", channel_id: channelRef.current }));
    }
  };

  // 채널만 바뀌면 연결은 그대로 두고 구독만 바꾼다
  useEffect(() => {
    channelRef.current = channelId;
    sendSubscribe(socketRef.current);
  }, [channelId]);

  useEffect(() => {
    if (!enabled) return;
    let retryMs = 1000;
    let retryTimer: number | undefined;
    let pingTimer: number | undefined;
    let stopped = false;

    const connect = () => {
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${scheme}://${window.location.host}/ws`);
      socketRef.current = socket;
      socket.onopen = () => {
        retryMs = 1000;
        sendSubscribe(socket);
        handlersRef.current.onStatus(true);
        handlersRef.current.onConnected();
        pingTimer = window.setInterval(() => socket.send("ping"), PING_INTERVAL_MS);
      };
      socket.onmessage = (message) => {
        if (typeof message.data !== "string" || message.data === "pong") return;
        try {
          handlersRef.current.onEvent(JSON.parse(message.data) as RealtimeEvent);
        } catch {
          // 알 수 없는 형식은 무시
        }
      };
      socket.onclose = (event) => {
        window.clearInterval(pingTimer);
        handlersRef.current.onStatus(false);
        if (stopped) return;
        if (event.code === POLICY_VIOLATION) {
          handlersRef.current.onRejected();
          return;
        }
        retryTimer = window.setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
      };
    };

    connect();
    return () => {
      stopped = true;
      window.clearTimeout(retryTimer);
      window.clearInterval(pingTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [enabled]);
}

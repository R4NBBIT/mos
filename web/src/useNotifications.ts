// 알림: 나를 부른 메시지(그리고 고르면 고정한 채널의 새 메시지)를 실시간 연결로 받아
// 탭 제목 앞 숫자와 브라우저 알림 창으로 알려 준다.
// 화면을 보고 있는 중에는 다른 채널, 포럼 글을 화면 안 작은 알림으로 알려 준다.
// 위장 화면 중에는 기본으로 알리지 않는다. '위장 화면일 때도 알림'을 켜면 알림 창만(내용, 소리, 화면 안 알림 없이).
// 내용은 설정에서 켠 경우에만 보인다.
import { useCallback, useEffect, useRef, useState } from "react";
import { isDisguised } from "./boss/bossState";
import { playSound } from "./notifySound";
import { currentBaseTitle, currentIcon, type NotifyScope, setTitleBadge } from "./theme";

const MAX_RETRY_MS = 30_000;
const PING_INTERVAL_MS = 30_000;
const POLICY_VIOLATION = 1008;
const PREVIEW_LIMIT = 80;
const TOAST_MS = 6000;

export interface NotifyEvent {
  message_id: string;
  channel_id: string;
  group_id: string;
  parent_id: string | null;
  channel_name: string;
  group_name: string;
  author_name: string;
  content: string;
  extra: string;
  mentioned: boolean;
}

export type PopupSupport = "granted" | "default" | "denied" | "unsupported";

/** 이 브라우저가 알림 창을 띄울 수 있는지. 아이폰 사파리(홈 화면 앱이 아닐 때)는 못 띄운다 */
export function popupSupport(): PopupSupport {
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission as PopupSupport;
}

/** 알림 창 허용 묻기(버튼을 눌렀을 때만 부른다) */
export async function askPopupPermission(): Promise<PopupSupport> {
  if (popupSupport() === "unsupported") return "unsupported";
  try {
    return (await Notification.requestPermission()) as PopupSupport;
  } catch {
    return popupSupport();
  }
}

/** 화면 안 작은 알림에 보일 것 */
interface TodoAlertEvent {
  title: string;
  body: string;
  /** 위장 화면일 때(할 일 알림 설정): off 안 띄움, silent 내용과 소리 없이, full 그대로 */
  boss_mode?: "off" | "silent" | "full";
}

export interface NotifyToast {
  /** 같은 내용이 다시 와도 새로 보이게 */
  key: number;
  route: string;
  title: string;
  body: string;
}

/** 알림 창에 넣을 한 줄: 디스코드 코드와 서식 기호를 뺀다 */
function previewText(event: NotifyEvent): string {
  const text = event.content
    .replace(/^> ↪ .*\n/, "")
    .replace(/<@[!&]?\d+>/g, "@멘션")
    .replace(/<#\d+>/g, "#채널")
    .replace(/<a?:(\w+):\d+>/g, ":$1:")
    .replace(/<\/([^:>]{1,100}):\d+>/g, "/$1")
    .replace(/<t:-?\d+(?::[tTdDfFR])?>/g, "(시간)")
    .replace(/\|\|[\s\S]+?\|\|/g, "(스포일러)")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const shown = text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text;
  return shown || (event.extra ? `(${event.extra})` : "");
}

/** 알림을 누르면 갈 화면 주소 */
export function notifyRoute(event: NotifyEvent): string {
  return event.parent_id
    ? `#/g/${event.group_id}/p/${event.parent_id}/t/${event.channel_id}`
    : `#/g/${event.group_id}/c/${event.channel_id}`;
}

interface Options {
  /** 알림을 켰고 계정이 열려 있을 때만 */
  enabled: boolean;
  scope: NotifyScope;
  preview: boolean;
  /** 위장 화면일 때도 알림 창 띄우기(내용 없이) */
  boss: boolean;
  /** 열린 계정이 바뀌면 다시 연결 */
  accountId: string | undefined;
  /** 지금 보고 있는 채널이나 포럼 글(보고 있는 곳의 새 글은 세지 않는다) */
  currentChannel: string | null;
  /** 지금 보고 있는 포럼(글 목록). 그 포럼의 글에 달린 새 메시지도 세지 않는다 */
  currentForum: string | null;
  onOpen: (route: string) => void;
}

export function useNotifications({
  enabled,
  scope,
  preview,
  boss,
  accountId,
  currentChannel,
  currentForum,
  onOpen,
}: Options): { toast: NotifyToast | null; closeToast: () => void } {
  const [toast, setToast] = useState<NotifyToast | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const closeToast = useCallback(() => {
    window.clearTimeout(toastTimer.current);
    setToast(null);
  }, []);
  const [counts, setCountsState] = useState<Record<string, number>>({});
  const countsRef = useRef<Record<string, number>>({});
  const setCounts = useCallback((next: Record<string, number>) => {
    countsRef.current = next;
    setCountsState(next);
  }, []);
  const optionsRef = useRef({ scope, preview, boss, currentChannel, currentForum, onOpen });
  optionsRef.current = { scope, preview, boss, currentChannel, currentForum, onOpen };
  const socketRef = useRef<WebSocket | null>(null);
  const popupRef = useRef<Notification | null>(null);

  const sendScope = useCallback((socket: WebSocket | null) => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "notify", scope: optionsRef.current.scope }));
    }
  }, []);

  const clearChannel = useCallback((channelId: string | null) => {
    if (!channelId || !(channelId in countsRef.current)) return;
    const next = { ...countsRef.current };
    delete next[channelId];
    setCounts(next);
  }, [setCounts]);

  // 화면을 보고 있을 때: 알림 창 대신 화면 안 작은 알림(휴대폰에서도 보인다)
  const showToast = useCallback((event: NotifyEvent) => {
    const showContent = optionsRef.current.preview;
    const place = event.channel_name ? `#${event.channel_name}` : "다른 채널";
    setToast({
      key: Date.now(),
      route: notifyRoute(event),
      title: showContent ? `${event.author_name} (${place})` : `${place}에 새 메시지`,
      body: showContent ? previewText(event) : "",
    });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  const showPopup = useCallback((event: NotifyEvent, total: number) => {
    const disguised = isDisguised();
    // 위장 중: 켜 둔 기기에서만, 소리와 화면 안 알림 없이 알림 창만(내용 없이)
    if (disguised && !optionsRef.current.boss) return;
    if (!disguised) {
      playSound(); // 켜 둔 기기에서만(설정 › 알림 › 알림 소리)
      if (document.visibilityState === "visible" && document.hasFocus()) {
        showToast(event);
        return;
      }
    }
    if (popupSupport() !== "granted") return;
    const showContent = optionsRef.current.preview && !disguised;
    const title = showContent ? `${event.author_name} (#${event.channel_name})` : currentBaseTitle();
    const body = showContent ? previewText(event) : `새 알림 ${total}건`;
    try {
      popupRef.current?.close();
      const popup = new Notification(title, { body, icon: currentIcon(), tag: "mos-notify", silent: false });
      popup.onclick = () => {
        window.focus();
        optionsRef.current.onOpen(notifyRoute(event));
        popup.close();
      };
      popupRef.current = popup;
    } catch {
      // 휴대폰 크롬은 페이지에서 바로 못 띄워 서비스 워커로(누르면 서비스 워커가 그 채널을 연다)
      void navigator.serviceWorker?.ready
        .then((registration) =>
          registration.showNotification(title, {
            body,
            tag: "mos-notify",
            data: { url: `/${notifyRoute(event)}` },
          }),
        )
        .catch(() => {});
    }
  }, [showToast]);

  // 할 일 알림(공개 전 기능, 서버가 허용된 계정에만 보냄). 위장 중에는 할 일 알림 설정을 따른다
  const showTodoAlert = useCallback((event: TodoAlertEvent) => {
    if (!event || typeof event.title !== "string" || typeof event.body !== "string") return;
    window.dispatchEvent(new Event("mos-todo-news")); // 소식 점, '할 일' 줄 다시 받기
    const disguised = isDisguised();
    const mode = event.boss_mode ?? "off";
    if (disguised && mode === "off") return;
    // 위장 중 '그대로'면 평소처럼(내용 보이기 설정은 따름), '조용히'면 내용과 소리 없이
    const quiet = disguised && mode !== "full";
    const showContent = optionsRef.current.preview && !quiet;
    if (!quiet) playSound();
    if (!disguised) {
      if (document.visibilityState === "visible" && document.hasFocus()) {
        setToast({
          key: Date.now(),
          route: "#/todo",
          title: showContent ? event.title : "할 일 알림",
          body: showContent ? event.body : "",
        });
        window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setToast(null), TOAST_MS);
        return;
      }
    }
    if (popupSupport() !== "granted") return;
    const title = showContent ? event.title : currentBaseTitle();
    const body = showContent ? event.body : "새 알림이 있어요";
    try {
      popupRef.current?.close();
      const popup = new Notification(title, { body, icon: currentIcon(), tag: "mos-notify", silent: quiet });
      popup.onclick = () => {
        window.focus();
        if (!isDisguised()) optionsRef.current.onOpen("#/todo");
        popup.close();
      };
      popupRef.current = popup;
    } catch {
      void navigator.serviceWorker?.ready
        .then((registration) => registration.showNotification(title, { body, tag: "mos-notify", data: { url: "/#/todo" } }))
        .catch(() => {});
    }
  }, []);

  // 연결: 알림을 켠 동안만. 끊기면 1초→…→30초 간격으로 다시
  useEffect(() => {
    if (!enabled || !accountId) return;
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
        sendScope(socket);
        pingTimer = window.setInterval(() => socket.send("ping"), PING_INTERVAL_MS);
      };
      socket.onmessage = (message) => {
        if (typeof message.data !== "string" || message.data === "pong") return;
        let parsed: { type?: string; data?: NotifyEvent };
        try {
          parsed = JSON.parse(message.data) as { type?: string; data?: NotifyEvent };
        } catch {
          return;
        }
        if (parsed.type === "todo_alert") {
          showTodoAlert(parsed.data as unknown as TodoAlertEvent);
          return;
        }
        const event = parsed.data;
        if (parsed.type !== "notify" || !event || !/^\d+$/.test(event.channel_id)) return;
        const { currentChannel: openChannel, currentForum: openForum } = optionsRef.current;
        const here = openChannel === event.channel_id || (openForum !== null && openForum === event.parent_id);
        const watching = here && document.visibilityState === "visible" && !isDisguised();
        if (watching) return;
        const current = countsRef.current;
        const next = { ...current, [event.channel_id]: (current[event.channel_id] ?? 0) + 1 };
        setCounts(next);
        showPopup(event, Object.values(next).reduce((sum, value) => sum + value, 0));
      };
      socket.onclose = (event) => {
        window.clearInterval(pingTimer);
        if (stopped || event.code === POLICY_VIOLATION) return; // 잠김·계정 바뀜이면 화면이 다시 연결한다
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
      setCounts({});
      closeToast();
    };
  }, [enabled, accountId, sendScope, showPopup, showTodoAlert, setCounts, closeToast]);

  // 범위를 바꾸면 연결은 그대로 두고 알려만 준다
  useEffect(() => sendScope(socketRef.current), [scope, sendScope]);

  // 알림이 가리키던 곳을 열면 작은 알림도 닫는다
  useEffect(() => {
    if (toast && (toast.route.endsWith(`/c/${currentChannel}`) || toast.route.endsWith(`/t/${currentChannel}`))) {
      closeToast();
    }
  }, [currentChannel, toast, closeToast]);

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  // 채널을 열면(그리고 탭으로 돌아오면) 그 채널 숫자는 지운다
  useEffect(() => {
    clearChannel(currentChannel);
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      clearChannel(optionsRef.current.currentChannel);
      popupRef.current?.close();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [currentChannel, clearChannel]);

  // 탭 제목 숫자
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  useEffect(() => {
    setTitleBadge(enabled ? total : 0);
  }, [enabled, total]);

  return { toast, closeToast };
}

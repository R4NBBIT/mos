import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError, fetchChannel, fetchMessages, logout } from "./api";
import { compareIds, dayKey, formatDay } from "./format";
import MessageItem from "./MessageItem";
import type { ChannelInfo, Message, RealtimeEvent } from "./types";
import { useRealtime } from "./useRealtime";

const GROUP_GAP_MS = 5 * 60 * 1000;
const NEAR_BOTTOM_PX = 120;

interface Props {
  onLoggedOut: () => void;
}

function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => compareIds(a.id, b.id));
}

export default function ChatRoom({ onLoggedOut }: Props) {
  const [channel, setChannel] = useState<ChannelInfo | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [connected, setConnected] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const [error, setError] = useState("");

  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const keepOffset = useRef<number | null>(null);

  const handleAuthError = useCallback(
    (caught: unknown) => {
      if (caught instanceof ApiError && caught.status === 401) {
        onLoggedOut();
        return true;
      }
      return false;
    },
    [onLoggedOut],
  );

  const loadLatest = useCallback(
    async (info: ChannelInfo) => {
      try {
        const page = await fetchMessages(info.id);
        setMessages((current) => mergeMessages(current, page.messages));
        setHasMore((previous) => previous || page.has_more);
      } catch (caught) {
        if (!handleAuthError(caught)) setError("메시지를 불러오지 못했어요.");
      }
    },
    [handleAuthError],
  );

  useEffect(() => {
    fetchChannel()
      .then((info) => {
        setChannel(info);
        return loadLatest(info);
      })
      .catch((caught) => {
        if (!handleAuthError(caught)) setError("채널 정보를 불러오지 못했어요.");
      });
  }, [handleAuthError, loadLatest]);

  const loadOlder = async () => {
    if (!channel || loadingOlder || messages.length === 0) return;
    const oldest = messages[0];
    if (!oldest) return;
    setLoadingOlder(true);
    try {
      const page = await fetchMessages(channel.id, oldest.id);
      const list = listRef.current;
      keepOffset.current = list ? list.scrollHeight - list.scrollTop : null;
      setMessages((current) => mergeMessages(current, page.messages));
      setHasMore(page.has_more);
    } catch (caught) {
      if (!handleAuthError(caught)) setError("이전 메시지를 불러오지 못했어요.");
    } finally {
      setLoadingOlder(false);
    }
  };

  useRealtime(channel !== null, {
    onStatus: setConnected,
    onConnected: () => {
      if (channel) void loadLatest(channel); // 끊긴 사이 메시지 채우기
    },
    onEvent: (event: RealtimeEvent) => {
      if (!channel) return;
      if (event.type === "message_delete") {
        if (event.data.channel_id !== channel.id) return;
        const removed = new Set(event.data.ids);
        setMessages((current) => current.filter((message) => !removed.has(message.id)));
        return;
      }
      if (event.data.channel_id !== channel.id) return;
      if (event.type === "message_create" && !stickToBottom.current) {
        setUnseen((count) => count + 1);
      }
      setMessages((current) => mergeMessages(current, [event.data]));
    },
  });

  // 이전 메시지를 위에 붙였을 때 보던 위치 유지, 아래에 있었으면 계속 맨 아래
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (keepOffset.current !== null) {
      list.scrollTop = list.scrollHeight - keepOffset.current;
      keepOffset.current = null;
    } else if (stickToBottom.current) {
      list.scrollTop = list.scrollHeight;
    }
  }, [messages]);

  const onScroll = () => {
    const list = listRef.current;
    if (!list) return;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < NEAR_BOTTOM_PX;
    stickToBottom.current = nearBottom;
    if (nearBottom) setUnseen(0);
    if (list.scrollTop < 40 && hasMore && !loadingOlder) void loadOlder();
  };

  const scrollToBottom = () => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
    stickToBottom.current = true;
    setUnseen(0);
  };

  const doLogout = async () => {
    try {
      await logout();
    } finally {
      onLoggedOut();
    }
  };

  return (
    <div className="room">
      <header className="room-header">
        <div className="room-title">
          <strong>{channel ? `# ${channel.name}` : "…"}</strong>
          <span className="room-sub">{channel?.guild_name ?? ""}</span>
        </div>
        <span className={connected ? "dot dot-on" : "dot"} title={connected ? "실시간 연결됨" : "연결 중"} />
        <button type="button" className="text-button" onClick={doLogout}>
          나가기
        </button>
      </header>

      <div className="room-list" ref={listRef} onScroll={onScroll}>
        {hasMore && (
          <button type="button" className="older-button" onClick={loadOlder} disabled={loadingOlder}>
            {loadingOlder ? "불러오는 중…" : "이전 메시지 더 보기"}
          </button>
        )}
        {error && <p className="room-error">{error}</p>}
        {messages.map((message, index) => {
          const previous = index > 0 ? messages[index - 1] : undefined;
          const newDay = !previous || dayKey(previous.created_at) !== dayKey(message.created_at);
          const grouped =
            !newDay &&
            previous !== undefined &&
            previous.author.id === message.author.id &&
            previous.author.name === message.author.name &&
            new Date(message.created_at).getTime() - new Date(previous.created_at).getTime() <
              GROUP_GAP_MS;
          return (
            <div key={message.id}>
              {newDay && <div className="day-divider">{formatDay(message.created_at)}</div>}
              <MessageItem message={message} grouped={grouped} />
            </div>
          );
        })}
      </div>

      {unseen > 0 && (
        <button type="button" className="unseen-pill" onClick={scrollToBottom}>
          새 메시지 {unseen}개 ↓
        </button>
      )}
      <footer className="room-footer">읽기 전용 미리보기(보내기는 다음 단계)</footer>
    </div>
  );
}

import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ApiError,
  deleteMessage,
  editMessage,
  fetchChannel,
  fetchMessages,
  markRead,
  sendFiles,
  sendMessage,
} from "./api";
import { isDisguised } from "./boss/bossState";
import Composer from "./Composer";
import { compareIds, dayKey, formatDay, formatTime } from "./format";
import MessageItem, { Avatar, MessageBody, type ReplyPreview } from "./MessageItem";
import SheetView from "./SheetView";
import type { Theme } from "./theme";
import type { ChannelInfo, Message, RealtimeEvent } from "./types";
import { useRealtime } from "./useRealtime";
import { isHiddenMessage, isSystemMessage } from "./systemMessage";

const GROUP_GAP_MS = 5 * 60 * 1000;
const NEAR_BOTTOM_PX = 120;

interface Props {
  channelId: string;
  /** 지금 계정의 디스코드 사용자 ID(내 메시지 알아보기) */
  myUserId: string;
  /** 채널 목록으로 */
  onBack: () => void;
  /** 좁은 화면에서만 뒤로 버튼(넓은 화면은 왼쪽에 목록이 있다) */
  showBack?: boolean;
  /** 일반 채널: 스레드 목록 열기 */
  onOpenThreads?: () => void;
  /** 오른쪽 위 계정 메뉴 */
  menu: ReactNode | null;
  /** 잠겼거나 세션이 끝나 401을 받았을 때 */
  onAuthLost: () => void;
  /** 계정 추가 실패 같은 한 번 보여 줄 안내 */
  notice?: string;
  onNoticeClose?: () => void;
  /** 테마: 시트는 표로, 메모장은 한 줄 기록으로 */
  theme?: Theme;
  /** 시트 탭에서 다른 채널 열기 */
  onOpenChannel?: (channel: ChannelInfo) => void;
}

function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => compareIds(a.id, b.id));
}

export default function ChatRoom({
  channelId,
  myUserId,
  onBack,
  showBack = true,
  onOpenThreads,
  menu,
  onAuthLost,
  notice,
  onNoticeClose,
  theme = "moon",
  onOpenChannel,
}: Props) {
  const [channel, setChannel] = useState<ChannelInfo | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [connected, setConnected] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const keepOffset = useRef<number | null>(null);

  const handleAuthError = useCallback(
    (caught: unknown) => {
      if (caught instanceof ApiError && caught.status === 401) {
        onAuthLost();
        return true;
      }
      return false;
    },
    [onAuthLost],
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

  // 서버를 막 켰을 때는 봇이 디스코드에 붙기 전이라 503이 온다. 붙을 때까지 다시 묻는다
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const attempt = async (delayMs: number) => {
      try {
        const info = await fetchChannel(channelId);
        if (stopped) return;
        setError("");
        setChannel(info);
        // 글·스레드는 본문(맨 위)부터 읽고, 채팅방은 최신(맨 아래)부터
        if (info.kind === "thread") stickToBottom.current = false;
        await loadLatest(info);
      } catch (caught) {
        if (stopped || handleAuthError(caught)) return;
        if (caught instanceof ApiError && caught.status === 404) {
          // 없는 채널이거나 이 계정으로는 볼 수 없는 채널. 다시 물어도 같으니 멈춘다
          setError("볼 수 없는 채널이에요. 목록으로 돌아가 주세요.");
          return;
        }
        if (caught instanceof ApiError && caught.status === 503) {
          setError("디스코드에 연결하는 중이에요…");
        } else {
          setError("채널 정보를 불러오지 못했어요. 다시 시도하는 중…");
        }
        timer = window.setTimeout(() => void attempt(Math.min(delayMs * 2, 15000)), delayMs);
      }
    };
    void attempt(1000);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [channelId, handleAuthError, loadLatest]);

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

  useRealtime(channel ? channel.id : null, {
    onStatus: setConnected,
    onRejected: onAuthLost,
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
      if (event.type !== "message_create" && event.type !== "message_update") return;
      const incoming = event.data;
      if (incoming.channel_id !== channel.id) return;
      if (event.type === "message_create" && !stickToBottom.current) {
        setUnseen((count) => count + 1);
      }
      setMessages((current) => mergeMessages(current, [incoming]));
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
    // 글·스레드는 맨 위에 본문 카드가 있어, 지난 댓글은 버튼으로만 불러온다
    if (!isThread && list.scrollTop < 40 && hasMore && !loadingOlder) void loadOlder();
  };

  const submit = async (text: string, nonce: string, files: File[]) => {
    if (!channel) return;
    if (editing) {
      const saved = await editMessage(editing.id, text);
      setMessages((current) => mergeMessages(current, [saved]));
      setEditing(null);
      return;
    }
    const sent =
      files.length > 0
        ? await sendFiles(channel.id, text, nonce, replyTo?.id ?? null, files)
        : await sendMessage(channel.id, text, nonce, replyTo?.id ?? null);
    stickToBottom.current = true;
    setMessages((current) => mergeMessages(current, [sent]));
    setReplyTo(null);
  };

  const remove = async (message: Message) => {
    await deleteMessage(message.id);
    setMessages((current) => current.filter((item) => item.id !== message.id));
    setSelectedId(null);
  };

  const byId = new Map(messages.map((message) => [message.id, message]));
  const isThread = channel?.kind === "thread";
  const isForumPost = isThread && channel?.parent_kind === "forum";
  // 글 ID = 첫 메시지 ID. 일반 채널 스레드는 시작 메시지가 부모 채널에 있다
  const starter = isThread ? (channel?.starter ?? byId.get(channel?.id ?? "") ?? null) : null;
  const shownMessages = (isThread ? messages.filter((message) => message.id !== channel?.id) : messages).filter(
    (message) => !isHiddenMessage(message),
  );
  const replyPreview = (message: Message): ReplyPreview | null => {
    const original = message.reference_id ? byId.get(message.reference_id) : undefined;
    if (!original) return null;
    const text = original.content.replace(/\s+/g, " ").slice(0, 40) || "(첨부)";
    return { author: original.author.name, text };
  };

  // 맨 아래를 보고 있고 탭이 보일 때, 마지막 메시지까지 읽음으로 남긴다(1초 모아서)
  const lastMarked = useRef<string | null>(null);
  useEffect(() => {
    if (!channel || messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (!last) return;
    const timer = window.setTimeout(() => {
      if (!stickToBottom.current || document.visibilityState !== "visible" || isDisguised()) return;
      if (lastMarked.current && compareIds(last.id, lastMarked.current) <= 0) return;
      lastMarked.current = last.id;
      markRead(channel.id, last.id).catch(() => {
        lastMarked.current = null; // 다음에 다시
      });
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [channel, messages, unseen]);

  const cardRef = useRef<HTMLDivElement>(null);
  const [cardVisible, setCardVisible] = useState(true);
  useEffect(() => {
    const card = cardRef.current;
    const list = listRef.current;
    if (!card || !list) return;
    const observer = new IntersectionObserver(
      ([entry]) => setCardVisible(Boolean(entry?.isIntersecting)),
      { root: list, threshold: 0 },
    );
    observer.observe(card);
    return () => observer.disconnect();
  }, [isThread, channel?.id]);

  const scrollToCard = () => {
    listRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  const scrollToBottom = () => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
    stickToBottom.current = true;
    setUnseen(0);
  };

  const composer = channel ? (
    <Composer
      placeholder={isThread ? (isForumPost ? "댓글 입력" : "스레드에 메시지 입력") : "메시지 입력"}
      readOnlyText={
        isThread
          ? channel.locked
            ? "잠긴 글이라 댓글을 쓸 수 없어요."
            : "이 글에는 댓글을 쓸 수 없어요."
          : undefined
      }
      channelId={channel.id}
      canSend={channel.can_send}
      replyTo={replyTo}
      editing={editing}
      onCancel={() => {
        setReplyTo(null);
        setEditing(null);
      }}
      onSubmit={submit}
    />
  ) : null;

  if (theme === "sheet") {
    return (
      <SheetView
        channel={channel}
        rows={isThread && starter ? [starter, ...shownMessages] : shownMessages}
        myUserId={myUserId}
        hasMore={hasMore}
        loadingOlder={loadingOlder}
        onLoadOlder={() => void loadOlder()}
        error={error}
        notice={notice}
        onNoticeClose={onNoticeClose}
        unseen={unseen}
        onScrollToBottom={scrollToBottom}
        connected={connected}
        listRef={listRef}
        onScroll={onScroll}
        selectedId={selectedId}
        onSelect={setSelectedId}
        replyPreview={replyPreview}
        onReply={(target) => {
          setEditing(null);
          setReplyTo(target);
          setSelectedId(null);
        }}
        onEdit={(target) => {
          setReplyTo(null);
          setEditing(target);
          setSelectedId(null);
        }}
        onDelete={remove}
        composer={composer}
        showBack={Boolean(showBack)}
        onBack={onBack}
        onOpenThreads={onOpenThreads}
        onOpenTab={onOpenChannel}
        menu={menu}
      />
    );
  }

  return (
    <div className="room">
      <header className="room-header">
        {showBack && (
          <button type="button" className="back-button" onClick={onBack} aria-label="채널 목록으로">
            ‹
          </button>
        )}
        <div className="room-title">
          <strong>
            {channel ? `${channel.kind === "thread" ? "↳" : "#"} ${channel.name}` : "…"}
            {channel?.locked && " 🔒"}
          </strong>
          <span className="room-sub">
            {isThread
              ? `${isForumPost ? "▤" : "#"} ${channel?.parent_name ?? ""} › ${isForumPost ? "글" : "스레드"}`
              : (channel?.group_name ?? "")}
            {channel?.archived ? " · 보관된 글(쓰면 다시 열려요)" : ""}
          </span>
        </div>
        {onOpenThreads && channel && channel.kind !== "thread" && (
          <button type="button" className="text-button header-link" onClick={onOpenThreads}>
            스레드
          </button>
        )}
        <span className={connected ? "dot dot-on" : "dot"} title={connected ? "실시간 연결됨" : "연결 중"} />
        {menu}
      </header>
      {notice && (
        <div className="room-notice" role="status">
          <span>{notice}</span>
          <button type="button" className="text-button" onClick={onNoticeClose} aria-label="안내 닫기">
            닫기
          </button>
        </div>
      )}

      {isThread && channel && !cardVisible && (
        <div className="post-sticky">
          <span className="post-sticky-title">
            {isForumPost ? "▤" : "↳"} {channel.name}
          </span>
          {channel.applied_tags?.map((tag) => (
            <span key={tag.id} className="tag-chip">
              {tag.emoji ? `${tag.emoji} ` : ""}
              {tag.name}
            </span>
          ))}
          <button type="button" className="text-button" onClick={scrollToCard}>
            본문 보기
          </button>
        </div>
      )}

      <div className={isThread ? "room-list room-comments" : "room-list"} ref={listRef} onScroll={onScroll}>
        {isThread && channel && (
          <div className="post-card" ref={cardRef}>
            <h1 className="post-card-title">
              {channel.locked && "🔒 "}
              {channel.name}
            </h1>
            {(channel.applied_tags?.length ?? 0) > 0 && (
              <div className="post-tags">
                {channel.applied_tags?.map((tag) => (
                  <span key={tag.id} className="tag-chip">
                    {tag.emoji ? `${tag.emoji} ` : ""}
                    {tag.name}
                  </span>
                ))}
              </div>
            )}
            {starter ? (
              <>
                <div className="post-card-author">
                  <Avatar url={starter.author.avatar_url} name={starter.author.name} />
                  <strong>{starter.author.name}</strong>
                  <span>{formatDay(starter.created_at)} {formatTime(starter.created_at)}</span>
                </div>
                <div className="post-card-body">
                  <MessageBody message={starter} />
                </div>
              </>
            ) : (
              <p className="post-card-missing">
                {isForumPost ? "본문을 불러오는 중이에요…" : "시작 메시지를 찾을 수 없어요."}
              </p>
            )}
          </div>
        )}
        {isThread && (
          <div className="comment-divider">
            {isForumPost ? "댓글" : "스레드 메시지"} {shownMessages.length}
            {hasMore ? "+" : ""}개
          </div>
        )}
        {hasMore && (
          <button type="button" className="older-button" onClick={loadOlder} disabled={loadingOlder}>
            {loadingOlder ? "불러오는 중…" : isThread ? "지난 댓글 더 보기" : "이전 메시지 더 보기"}
          </button>
        )}
        {error && <p className="room-error">{error}</p>}
        {shownMessages.map((message, index) => {
          const previous = index > 0 ? shownMessages[index - 1] : undefined;
          const newDay = !previous || dayKey(previous.created_at) !== dayKey(message.created_at);
          const grouped =
            !newDay &&
            previous !== undefined &&
            !isSystemMessage(previous) &&
            previous.author.id === message.author.id &&
            previous.author.name === message.author.name &&
            new Date(message.created_at).getTime() - new Date(previous.created_at).getTime() <
              GROUP_GAP_MS;
          return (
            <div key={message.id}>
              {newDay && <div className="day-divider">{formatDay(message.created_at)}</div>}
              <MessageItem
                message={message}
                grouped={grouped}
                mine={message.web_sender_id === myUserId || message.author.id === myUserId}
                manageable={message.web_sender_id === myUserId && Boolean(channel?.can_send)}
                canReply={Boolean(channel?.can_send)}
                reply={replyPreview(message)}
                selected={selectedId === message.id}
                onSelect={setSelectedId}
                onReply={(target) => {
                  setEditing(null);
                  setReplyTo(target);
                  setSelectedId(null);
                }}
                onEdit={(target) => {
                  setReplyTo(null);
                  setEditing(target);
                  setSelectedId(null);
                }}
                onDelete={remove}
                layout={theme === "memo" ? "line" : isThread ? "comment" : "bubble"}
              />
            </div>
          );
        })}
      </div>

      {unseen > 0 && (
        <button type="button" className="unseen-pill" onClick={scrollToBottom}>
          새 메시지 {unseen}개 ↓
        </button>
      )}
      {composer}
    </div>
  );
}

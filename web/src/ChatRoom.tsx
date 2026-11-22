import BackIcon from "./BackIcon";
import SplitToggle from "./SplitToggle";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ApiError,
  deleteMessage,
  editMessage,
  fetchChannel,
  fetchMessages,
  markRead,
  sendFiles,
  sendMessage,
  sendSticker,
  toggleReaction,
} from "./api";
import { isDisguised } from "./boss/bossState";
import Composer from "./Composer";
import EditableText from "./EditableText";
import { useLook } from "./lookContext";
import { compareIds, dayKey, formatDay, formatTime } from "./format";
import MessageItem, { Avatar, MessageBody, paraColor, personId, type ReplyPreview } from "./MessageItem";
import SheetView, { plainText } from "./SheetView";
import Drawer, { drawerTitle, type DrawerTab } from "./Drawer";
import type { Theme } from "./theme";
import type { ChannelInfo, Message, RealtimeEvent } from "./types";
import PostEditor from "./PostEditor";
import { useRealtime } from "./useRealtime";
import { isHiddenMessage, isSystemMessage } from "./systemMessage";

const GROUP_GAP_MS = 5 * 60 * 1000;
// 서랍에서 고른 메시지로 갈 때: 이전 메시지를 100개씩 최대 15번(1500개)까지 더 받는다
const JUMP_PAGE_SIZE = 100;
const JUMP_MAX_PAGES = 15;
const JUMP_FLASH_MS = 2200;
const SCROLL_HOLD_MS = 1500;
const NARROW_QUERY = "(max-width: 760px)";
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

const reactionErrors: Record<string, string> = {
  reacted_in_discord: "디스코드 앱에서 단 반응은 디스코드에서 빼 주세요.",
  emoji_not_allowed: "이 이모지는 반응으로 쓸 수 없어요(움직이는 이모지와 다른 서버 이모지는 니트로가 필요해요).",
  no_permission: "이 채널에서는 반응을 달 수 없어요.",
  bad_emoji: "디스코드에서 쓸 수 없는 이모지예요.",
  rate_limited: "너무 빨리 눌렀어요. 잠깐 뒤에 다시 해 주세요.",
};

function reactionErrorText(caught: unknown): string {
  return (caught instanceof ApiError && reactionErrors[caught.code]) || "반응을 달지 못했어요. 잠시 후 다시 해 주세요.";
}

/** Word 머리 줄: 최근에 쓴 사람들을 '편집 중' 동그라미(첫 글자)로. 프로필 사진은 쓰지 않는다 */
function Coauthors({ messages, myUserId }: { messages: Message[]; myUserId: string }) {
  const people: { id: string; name: string }[] = [];
  for (const message of messages.slice(-40).reverse()) {
    if (people.length >= 4) break;
    const { author } = message;
    if (isSystemMessage(message) || author.id === myUserId || message.web_sender_id === myUserId) continue;
    const id = personId(message);
    if (!people.some((person) => person.id === id)) {
      people.push({ id, name: author.name });
    }
  }
  if (people.length === 0) return null;
  return (
    <div className="coauthors" aria-label={`편집 중: ${people.map((person) => person.name).join(", ")}`}>
      {people.map((person) => (
        <span
          key={`${person.id}:${person.name}`}
          className="coauthor"
          title={`${person.name} 편집 중`}
          style={{ "--who": paraColor(person.id) } as CSSProperties}
          aria-hidden="true"
        >
          {person.name.slice(0, 1)}
        </span>
      ))}
    </div>
  );
}

function IconTable() {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="3" y="4" width="14" height="12" rx="1.5" />
      <path d="M3 8h14M3 12h14M8 4v12" />
    </svg>
  );
}

function IconBoard() {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="3" y="4" width="4" height="12" rx="1" />
      <rect x="8.5" y="4" width="4" height="8" rx="1" />
      <rect x="14" y="4" width="3" height="10" rx="1" />
    </svg>
  );
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
  const {
    settings: { doc_titles: docTitles },
    save: saveLook,
  } = useLook();
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [connected, setConnected] = useState(false);
  // 접속 표시는 두지 않고, 5초 넘게 끊겨 있을 때만 알린다(처음 연결 중에는 조용히)
  const [lostLong, setLostLong] = useState(false);
  const everConnected = useRef(false);
  useEffect(() => {
    if (connected) {
      everConnected.current = true;
      setLostLong(false);
      return;
    }
    if (!everConnected.current) return;
    const timer = window.setTimeout(() => setLostLong(true), 5000);
    return () => window.clearTimeout(timer);
  }, [connected]);
  const [unseen, setUnseen] = useState(0);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  // 구분선이나 고른 메시지로 옮긴 직후 잠깐은 '맨 아래 근처'로 보지 않는다(짧은 대화에서 다시 맨 아래로 끌려가지 않게)
  const holdScrollUntil = useRef(0);
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
      if (event.type === "reactions_update") {
        if (event.data.channel_id !== channel.id) return;
        const { message_id: messageId, reactions } = event.data;
        setMessages((current) =>
          current.map((message) => (message.id === messageId ? { ...message, reactions } : message)),
        );
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

  // 맨 아래를 보고 있으면, 목록 크기가 바뀌거나(휴대폰 키보드·입력창 높이) 그림이 늦게 떠도 맨 아래 유지
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const keep = () => {
      if (stickToBottom.current && keepOffset.current === null) list.scrollTop = list.scrollHeight;
    };
    const observer = new ResizeObserver(keep);
    observer.observe(list);
    list.addEventListener("load", keep, true); // 그림은 이벤트가 위로 안 올라와 잡아채기로
    window.visualViewport?.addEventListener("resize", keep);
    return () => {
      observer.disconnect();
      list.removeEventListener("load", keep, true);
      window.visualViewport?.removeEventListener("resize", keep);
    };
  }, [channel?.id, theme]);

  const onScroll = () => {
    const list = listRef.current;
    if (!list) return;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < NEAR_BOTTOM_PX;
    if (performance.now() >= holdScrollUntil.current) {
      stickToBottom.current = nearBottom;
      if (nearBottom) setUnseen(0);
    }
    // 글·스레드는 맨 위에 본문 카드가 있어, 지난 댓글은 버튼으로만 불러온다
    if (!isThread && list.scrollTop < 40 && hasMore && !loadingOlder) void loadOlder();
  };

  const submit = async (text: string, nonce: string, files: File[]) => {
    if (!channel) return;
    if (!editing) stickToBottom.current = true; // 보내면 내 글이 보이게 맨 아래로(먼저 도착하는 실시간 이벤트 포함)
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

  // 반응: 누르면 바로 서버에 보내고 돌아온 목록으로 바꾼다(실시간 이벤트로도 온다)
  const [reactError, setReactError] = useState("");
  useEffect(() => {
    if (!reactError) return;
    const timer = window.setTimeout(() => setReactError(""), 4000);
    return () => window.clearTimeout(timer);
  }, [reactError]);
  const react = useCallback((message: Message, emoji: string) => {
    toggleReaction(message.id, emoji)
      .then((reactions) =>
        setMessages((current) => current.map((item) => (item.id === message.id ? { ...item, reactions } : item))),
      )
      .catch((caught: unknown) => setReactError(reactionErrorText(caught)));
  }, []);

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
  // 새 메시지 구분선: 채널을 연 때의 읽은 위치를 그대로 기억(읽어 내려가도 줄은 그 자리)
  const [readAtOpen, setReadAtOpen] = useState<string | null>(null);
  useEffect(() => {
    if (channel && readAtOpen === null) setReadAtOpen(channel.last_read_id ?? "");
  }, [channel, readAtOpen]);
  // 처음 열 때 새 메시지가 화면보다 많으면 구분선이 위쪽에 오게(적으면 평소처럼 맨 아래)
  const jumpedToNew = useRef(false);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || jumpedToNew.current || !readAtOpen || messages.length === 0) return;
    jumpedToNew.current = true;
    const mark = list.querySelector<HTMLElement>(NEW_MARK_SELECTOR);
    if (!mark) return;
    const top = mark.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    if (list.scrollHeight - top > list.clientHeight) {
      stickToBottom.current = false;
      holdScrollUntil.current = performance.now() + SCROLL_HOLD_MS;
      list.scrollTop = Math.max(0, top - 16);
    }
  }, [messages, readAtOpen]);
  // 서랍(찾기, 고정, 사진, 파일, 사람)과 거기서 고른 메시지로 가기
  const [drawerTab, setDrawerTab] = useState<DrawerTab | null>(null);
  const [jumpedId, setJumpedId] = useState<string | null>(null);
  const [jumpNote, setJumpNote] = useState("");
  const pendingJump = useRef<string | null>(null);
  const [jumpTick, setJumpTick] = useState(0);
  useLayoutEffect(() => {
    const id = pendingJump.current;
    const list = listRef.current;
    if (!id || !list) return;
    const row = list.querySelector<HTMLElement>(`[data-mid="${id}"]`);
    if (!row) return;
    pendingJump.current = null;
    stickToBottom.current = false;
    holdScrollUntil.current = performance.now() + SCROLL_HOLD_MS;
    row.scrollIntoView({ block: "center" });
    setJumpedId(id);
  }, [messages, jumpTick]);
  useEffect(() => {
    if (!jumpedId) return;
    const timer = window.setTimeout(() => setJumpedId(null), JUMP_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [jumpedId]);
  const jumpTo = async (id: string) => {
    if (!channel || !/^[0-9]{15,21}$/.test(id)) return;
    setJumpNote("");
    if (window.matchMedia(NARROW_QUERY).matches) setDrawerTab(null); // 휴대폰은 서랍이 대화를 가린다
    if (isThread && id === channel.id) {
      listRef.current?.scrollTo({ top: 0 }); // 글의 본문(맨 위 카드)
      return;
    }
    let loaded = messages;
    let more = hasMore;
    // 아직 안 받은 옛 메시지면 거기까지 이전 메시지를 더 받는다(너무 멀면 멈춘다)
    for (let page = 0; page < JUMP_MAX_PAGES && more && !loaded.some((item) => item.id === id); page += 1) {
      const oldest = loaded[0];
      if (!oldest) break;
      try {
        const older = await fetchMessages(channel.id, oldest.id, JUMP_PAGE_SIZE);
        loaded = mergeMessages(loaded, older.messages);
        more = older.has_more;
      } catch (caught) {
        if (!handleAuthError(caught)) setJumpNote("메시지를 불러오지 못했어요.");
        return;
      }
    }
    if (!loaded.some((item) => item.id === id)) {
      setJumpNote("너무 예전 메시지라 여기서 바로 갈 수 없어요.");
      return;
    }
    pendingJump.current = id;
    keepOffset.current = null;
    stickToBottom.current = false;
    if (loaded !== messages) {
      setMessages(loaded);
      setHasMore(more);
    }
    setJumpTick((tick) => tick + 1);
  };
  const drawer =
    channel && drawerTab ? (
      <Drawer
        channel={channel}
        tab={drawerTab}
        onTab={setDrawerTab}
        onJump={(id) => void jumpTo(id)}
        onClose={() => setDrawerTab(null)}
        onAuthLost={onAuthLost}
      />
    ) : null;
  const jumpNotice = jumpNote ? (
    <div className="room-notice room-notice-quiet" role="status">
      <span>{jumpNote}</span>
      <button type="button" className="text-button" onClick={() => setJumpNote("")}>
        닫기
      </button>
    </div>
  ) : null;
  const isNewMessage = (message: Message) =>
    Boolean(readAtOpen) &&
    BigInt(message.id) > BigInt(readAtOpen as string) &&
    !isSystemMessage(message) &&
    message.author.id !== myUserId &&
    message.web_sender_id !== myUserId;
  const newMarks: { first: string | null; count: number } = {
    first: null,
    count: 0,
  };
  const shownMessages = (isThread ? messages.filter((message) => message.id !== channel?.id) : messages).filter(
    (message) => !isHiddenMessage(message),
  );
  const replyPreview = (message: Message): ReplyPreview | null => {
    const original = message.reference_id ? byId.get(message.reference_id) : undefined;
    if (!original) return null;
    const sticker = original.stickers?.[0];
    const text =
      plainText(original).slice(0, 40) || (sticker ? `[스티커] ${sticker.name}` : "(첨부)");
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
      placeholder={
        theme === "word"
          ? "여기에 입력하고 Enter"
          : isThread
            ? isForumPost
              ? "댓글 입력"
              : "스레드에 메시지 입력"
            : "메시지 입력"
      }
      readOnlyText={
        isThread
          ? channel.locked
            ? "잠긴 글이라 댓글을 쓸 수 없어요."
            : "이 글에는 댓글을 쓸 수 없어요."
          : undefined
      }
      channelId={channel.id}
      groupId={channel.group_id}
      viewChannelId={channel.parent_id ?? channel.id}
      slowmode={channel.slowmode ?? 0}
      canSend={channel.can_send}
      replyTo={replyTo}
      editing={editing}
      onCancel={() => {
        setReplyTo(null);
        setEditing(null);
      }}
      onSubmit={submit}
      onSticker={async (stickerId) => {
        const sent = await sendSticker(channel.id, stickerId, crypto.randomUUID(), replyTo?.id ?? null);
        stickToBottom.current = true;
        setMessages((current) => mergeMessages(current, [sent]));
        setReplyTo(null);
      }}
    />
  ) : null;

  const toggleDrawer = () => setDrawerTab((current) => (current ? null : "search"));
  if (theme === "sheet") {
    return (
      <>
        <SheetView
          channel={channel}
          rows={isThread && starter ? [starter, ...shownMessages] : shownMessages}
          myUserId={myUserId}
          hasMore={hasMore}
          loadingOlder={loadingOlder}
          onLoadOlder={() => void loadOlder()}
          error={error}
          notice={jumpNote || notice}
          onNoticeClose={jumpNote ? () => setJumpNote("") : onNoticeClose}
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
          onReact={react}
          reactError={reactError}
          composer={composer}
          isNewMessage={isNewMessage}
          onPostEdited={(changes) => setChannel((current) => (current ? { ...current, ...changes } : current))}
          showBack={Boolean(showBack)}
          onBack={onBack}
          onOpenThreads={onOpenThreads}
          onOpenDrawer={channel ? toggleDrawer : undefined}
        jumpedId={jumpedId}
          onOpenTab={onOpenChannel}
          menu={menu}
        />
        {drawer}
      </>
    );
  }

  return (
    <div className="room">
      <header className="room-header">
        <SplitToggle />
        {showBack && (
          <button type="button" className="back-button" onClick={onBack} aria-label="채널 목록으로">
            <BackIcon />
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
            {channel?.archived ? " (보관됨, 쓰면 다시 열려요)" : ""}
          </span>
        </div>
        {channel && (
          <button
            type="button"
            className="text-button header-link"
            aria-expanded={Boolean(drawerTab)}
            onClick={toggleDrawer}
          >
            {drawerTitle(theme)}
          </button>
        )}
        {onOpenThreads && channel && channel.kind !== "thread" && (
          <button type="button" className="text-button header-link" onClick={onOpenThreads}>
            스레드
          </button>
        )}
        {theme === "word" && <Coauthors messages={shownMessages} myUserId={myUserId} />}
        {menu}
      </header>
      {reactError && (
        <div className="room-notice room-notice-quiet" role="status">
          <span>{reactError}</span>
        </div>
      )}
      {jumpNotice}
      {lostLong && (
        <div className="room-notice room-notice-quiet" role="status">
          <span>연결이 끊겨 다시 연결하는 중이에요. 그동안 새 글이 늦게 보일 수 있어요.</span>
        </div>
      )}
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
            <PostEditor
              channel={channel}
              onSaved={(changes) => setChannel((current) => (current ? { ...current, ...changes } : current))}
            />
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
        {theme === "word" && channel && !isThread && (
          // Word 문서 첫머리: 채널 이름이 문서 제목
          <div className="wd-head">
            <EditableText
              as="h1"
              className="wd-title"
              value={docTitles[channel.id] ?? channel.name}
              fallback={channel.name}
              label="문서 제목"
              onSave={(text) => void saveLook({ doc_titles: { [channel.id]: text } })}
            />
            <EditableText
              as="p"
              className="wd-sub"
              value={docTitles[`${channel.id}:sub`] ?? `${channel.group_name} / 공동 작성 문서`}
              fallback={`${channel.group_name} / 공동 작성 문서`}
              label="문서 부제목"
              onSave={(text) => void saveLook({ doc_titles: { [`${channel.id}:sub`]: text } })}
            />
          </div>
        )}
        {theme === "note" && channel && (
          // 노션 표 보기: 페이지 제목, 보기 탭, 열 머리(스크롤해도 위에 남음)
          <>
            {!isThread && (
              <div className="db-head">
                <EditableText
                  as="h1"
                  className="db-title"
                  value={docTitles[channel.id] ?? channel.name}
                  fallback={channel.name}
                  label="페이지 제목"
                  onSave={(text) => void saveLook({ doc_titles: { [channel.id]: text } })}
                />
                <div className="db-views">
                  <span className="db-view db-view-on">
                    <IconTable /> 표
                  </span>
                  <span className="db-view">
                    <IconBoard /> 보드
                  </span>
                  <span className="db-count">개수 {shownMessages.length}</span>
                  {channel.can_send && (
                    <button
                      type="button"
                      className="db-new"
                      onClick={() => document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus()}
                    >
                      새로 만들기
                    </button>
                  )}
                </div>
              </div>
            )}
            <div className="db-row db-header" role="row">
              <div className="db-cell db-time" role="columnheader">
                작성 일시
              </div>
              <div className="db-cell db-author" role="columnheader">
                작성자
              </div>
              <div className="db-cell db-content" role="columnheader">
                내용
              </div>
              <div className="db-cell db-react" role="columnheader">
                반응
              </div>
            </div>
          </>
        )}
        {hasMore && (
          <button type="button" className="older-button" onClick={loadOlder} disabled={loadingOlder}>
            {loadingOlder ? "불러오는 중…" : isThread ? "지난 댓글 더 보기" : "이전 메시지 더 보기"}
          </button>
        )}
        {error && <p className="room-error">{error}</p>}
        {(() => {
          // 첫 새 메시지 앞에 구분선(노션은 새 메시지마다 시각 앞 작은 점만)
          newMarks.first = shownMessages.find(isNewMessage)?.id ?? null;
          newMarks.count = newMarks.first ? shownMessages.filter(isNewMessage).length : 0;
          return null;
        })()}
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
          const fresh = theme === "note" && isNewMessage(message);
          return (
            <div
              key={message.id}
              data-mid={message.id}
              className={
                [fresh ? "msg-new" : "", message.id === jumpedId ? "msg-jump" : ""].filter(Boolean).join(" ") ||
                undefined
              }
            >
              {newDay && <div className="day-divider">{formatDay(message.created_at)}</div>}
              {message.id === newMarks.first && <NewDivider theme={theme} first={message} count={newMarks.count} />}
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
                onReact={react}
                myUserId={myUserId}
                channelId={channel?.id}
                layout={
                  theme === "memo"
                    ? "line"
                    : theme === "note"
                      ? "row"
                      : theme === "word"
                        ? "para"
                        : isThread
                          ? "comment"
                          : "bubble"
                }
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
      {drawer}
    </div>
  );
}

const NEW_MARK_SELECTOR = ".new-divider, .new-divider-memo, .new-divider-word, .msg-new, .sheet-row-new";

/**
 * 새 메시지 구분선. 위장 테마는 그 프로그램에 원래 있는 표시를 빌린다(시안 결정: 메모장 A, Word C).
 * 기본, 다크는 분명한 꿀색 줄. 노션은 줄 대신 행마다 작은 점(CSS .msg-new)
 */
function NewDivider({ theme, first, count }: { theme: string; first: Message; count: number }) {
  if (theme === "note") return null;
  if (theme === "memo") {
    return (
      <div className="new-divider-memo" role="separator" aria-label="여기부터 새 메시지">
        --------------------------------
      </div>
    );
  }
  if (theme === "word") {
    return (
      <div className="new-divider-word" role="note" aria-label="여기부터 새 메시지">
        메모: {formatTime(first.created_at)} 이후 내용 {count}개
      </div>
    );
  }
  return (
    <div className="new-divider" role="separator" aria-label="여기부터 새 메시지">
      <span>새 메시지</span>
    </div>
  );
}

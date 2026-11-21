import { type ReactNode, type RefObject, useEffect, useState } from "react";
import { fetchGroupChannels } from "./api";
import { dayKey, formatDay } from "./format";
import { AttachmentText, AttachmentView, isPicture, MessageTextOnly, StickerView, type ReplyPreview } from "./MessageItem";
import type { ChannelInfo, Message } from "./types";
import { isSystemMessage, systemText } from "./systemMessage";
import MessageContent from "./MessageContent";

// 스프레드시트 테마 대화방(화면명세서 SCR-11). 메시지 하나 = 행 하나.
// A 시간 · B 보낸 사람 · C 내용 · D 반응, 맨 아래 입력 행, 시트 탭 = 같은 모임의 채널

const RIBBON = ["붙여넣기", "가", "가", "가", "≡", "≡", "≡", "%", "조건부 서식", "표 서식", "Σ 자동 합계", "정렬"];
const MENUS = ["파일", "홈", "삽입", "페이지 레이아웃", "수식", "데이터", "검토", "보기"];
const TAB_REFRESH_MS = 20000;
const TITLE_ROW = 1;

/** 셀에 맞게 짧은 24시간 표기(14:05) */
function cellTime(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 셀에 넣을 한 줄 글자: 멘션·이모지 코드를 이름으로 */
export function plainText(message: Message): string {
  return message.content
    .replace(/<@!?(\d+)>/g, (_, id: string) => `@${message.mentions.users[id] ?? "알 수 없음"}`)
    .replace(/<@&(\d+)>/g, (_, id: string) => `@${message.mentions.roles[id] ?? "역할"}`)
    .replace(/<#(\d+)>/g, (_, id: string) => `#${message.mentions.channels[id] ?? "채널"}`)
    .replace(/<a?:(\w+):\d+>/g, ":$1:")
    .replace(/<t:(-?\d+)(?::[tTdDfFR])?>/g, (_, sec: string) => new Date(Number(sec) * 1000).toLocaleString("ko-KR"))
    .replace(/\|\|[\s\S]+?\|\|/g, "(스포일러)")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/^(#{1,3}|>{1,3}|-#) /gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface Props {
  channel: ChannelInfo | null;
  /** 보여 줄 행(글·스레드면 첫 메시지가 맨 위) */
  rows: Message[];
  myUserId: string;
  hasMore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  error: string;
  notice?: string;
  onNoticeClose?: () => void;
  unseen: number;
  onScrollToBottom: () => void;
  connected: boolean;
  listRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  replyPreview: (message: Message) => ReplyPreview | null;
  onReply: (message: Message) => void;
  onEdit: (message: Message) => void;
  onDelete: (message: Message) => Promise<void>;
  composer: ReactNode;
  showBack: boolean;
  onBack: () => void;
  onOpenThreads?: () => void;
  onOpenTab?: (channel: ChannelInfo) => void;
  menu: ReactNode | null;
}

function SheetTabs({
  channel,
  onOpenTab,
}: {
  channel: ChannelInfo;
  onOpenTab?: (channel: ChannelInfo) => void;
}) {
  const [tabs, setTabs] = useState<ChannelInfo[]>([]);
  const groupId = channel.group_id;
  useEffect(() => {
    let stopped = false;
    const load = () =>
      fetchGroupChannels(groupId)
        .then((value) => {
          if (!stopped) setTabs(value.channels.filter((item) => item.kind !== "thread"));
        })
        .catch(() => {});
    void load();
    const timer = window.setInterval(() => void load(), TAB_REFRESH_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [groupId]);
  const activeId = channel.kind === "thread" ? channel.parent_id : channel.id;
  const shown = tabs.length > 0 ? tabs : [channel];
  return (
    <nav className="sheet-tabs" aria-label="채널">
      {shown.map((tab) => {
        const active = tab.id === activeId || (tab.id === channel.id && tabs.length === 0);
        const label = active && channel.kind === "thread" ? `${tab.name} › ${channel.name}` : tab.name;
        return (
          <button
            key={tab.id}
            type="button"
            className={active ? "sheet-tab sheet-tab-on" : "sheet-tab"}
            aria-current={active ? "page" : undefined}
            onClick={() => {
              if (tab.id !== channel.id) onOpenTab?.(tab);
            }}
          >
            {label}
            {!active && (tab.unread ?? 0) > 0 ? ` (${tab.unread})` : ""}
          </button>
        );
      })}
    </nav>
  );
}

export default function SheetView(props: Props) {
  const { channel, rows, myUserId, selectedId } = props;
  const [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState("");
  const byId = new Map(rows.map((message) => [message.id, message]));
  const selected = selectedId ? (byId.get(selectedId) ?? null) : null;

  useEffect(() => {
    setConfirming(false);
    setActionError("");
  }, [selectedId]);

  const canSend = Boolean(channel?.can_send);
  const manageable = selected !== null && selected.web_sender_id === myUserId && canSend;

  // 행 번호: 1행은 머리글(글·스레드는 1행 제목, 2행 머리글), 날짜가 바뀌면 날짜 행이 하나 끼어든다
  const isThread = channel?.kind === "thread";
  const headRow = isThread ? TITLE_ROW + 1 : 1;
  let rowNumber = headRow;
  const body: ReactNode[] = [];
  const rowNumberOf = new Map<string, number>();
  rows.forEach((message, index) => {
    const previous = index > 0 ? rows[index - 1] : undefined;
    if (!previous || dayKey(previous.created_at) !== dayKey(message.created_at)) {
      rowNumber += 1;
      body.push(
        <div className="sheet-row sheet-row-day" key={`day-${message.id}`}>
          <span className="sheet-rownum">{rowNumber}</span>
          <span className="sheet-cell">{formatDay(message.created_at)}</span>
          <span className="sheet-cell" />
          <span className="sheet-cell" />
          <span className="sheet-cell sheet-wide" />
          <span className="sheet-cell sheet-wide" />
          <span className="sheet-cell sheet-wide" />
        </div>,
      );
    }
    rowNumber += 1;
    rowNumberOf.set(message.id, rowNumber);
    if (isSystemMessage(message)) {
      // 입장·고정 같은 알림은 내용 칸에 회색 기울임 글자로
      body.push(
        <div className="sheet-row sheet-row-system" key={message.id}>
          <span className="sheet-rownum">{rowNumber}</span>
          <span className="sheet-cell">{cellTime(message.created_at)}</span>
          <span className="sheet-cell" />
          <span className="sheet-cell sheet-cell-c">{systemText(message)}</span>
          <span className="sheet-cell" />
          <span className="sheet-cell sheet-wide" />
          <span className="sheet-cell sheet-wide" />
        </div>,
      );
      return;
    }
    const mine = message.web_sender_id === myUserId || message.author.id === myUserId;
    const reply = message.reference_id ? props.replyPreview(message) : null;
    const isSelected = message.id === selectedId;
    const classes = ["sheet-row"];
    if (mine) classes.push("sheet-row-mine");
    if (isSelected) classes.push("sheet-row-selected");
    const isStarter = isThread && message.id === channel?.id;
    if (isStarter) classes.push("sheet-row-starter");
    const text = plainText(message);
    const pictures = message.attachments.filter(isPicture);
    const stickers = message.stickers ?? [];
    body.push(
      <div
        className={classes.join(" ")}
        key={message.id}
        onClick={() => props.onSelect(isSelected ? null : message.id)}
      >
        <span className="sheet-rownum">{rowNumber}</span>
        <span className="sheet-cell">{cellTime(message.created_at)}</span>
        <span className="sheet-cell">{message.author.name}</span>
        <span
          className={[
            "sheet-cell sheet-cell-c",
            message.reference_id ? "sheet-has-note" : "",
            pictures.length + stickers.length > 0 ? "sheet-cell-pics" : "",
          ].join(" ")}
          title={reply ? `↪ ${reply.author}: ${reply.text}` : undefined}
        >
          {message.content && (
            // 서식(굵게·기울임·링크·스포일러 등)은 그대로, 여러 줄은 한 줄로 이어서
            <span className="sheet-md">
              <MessageContent content={message.content} mentions={message.mentions} />
            </span>
          )}
          {message.embeds.length > 0 && !text ? `[${message.embeds[0]?.title || "링크 미리보기"}]` : ""}
          {message.attachments
            .filter((attachment) => !isPicture(attachment))
            .map((attachment) => (
              <span key={attachment.id}>
                {" "}
                <AttachmentText attachment={attachment} />
              </span>
            ))}
          {pictures.length + stickers.length > 0 && (
            // 셀 안에 삽입한 그림처럼(행이 그만큼 높아진다)
            <span className="sheet-pics">
              {stickers.map((sticker) => (
                <StickerView key={sticker.id} sticker={sticker} />
              ))}
              {pictures.map((attachment) => (
                <AttachmentView key={attachment.id} attachment={attachment} />
              ))}
            </span>
          )}
        </span>
        <span className="sheet-cell">
          {isStarter ? "본문" : isThread ? "댓글" : ""}
          {message.edited_at ? `${isThread ? " " : ""}(수정됨)` : ""}
        </span>
        <span className="sheet-cell sheet-wide" />
        <span className="sheet-cell sheet-wide" />
      </div>,
    );
  });
  const inputRow = rowNumber + 1;
  const nameBox = selected ? `C${rowNumberOf.get(selected.id) ?? ""}` : `C${inputRow}`;
  const selectedReply = selected ? props.replyPreview(selected) : null;

  const remove = async () => {
    if (!selected) return;
    setActionError("");
    try {
      await props.onDelete(selected);
    } catch {
      setActionError("지우지 못했어요.");
    }
  };

  const forumPost = channel?.kind === "thread" && channel.parent_kind === "forum";

  return (
    <SheetFrame
      showBack={props.showBack}
      onBack={props.onBack}
      connected={props.connected}
      menu={props.menu}
      menuExtra={
        props.onOpenThreads && channel && channel.kind !== "thread" ? (
          <button type="button" className="sheet-menu sheet-menu-link" onClick={props.onOpenThreads}>
            스레드
          </button>
        ) : null
      }
      nameBox={nameBox}
      formula={
        selected ? (
          <>
            {selectedReply && (
              <span className="sheet-formula-reply">
                ↪ {selectedReply.author}: {selectedReply.text}
                <br />
              </span>
            )}
            <MessageTextOnly message={selected} />
          </>
        ) : null
      }
      actions={
        selected && (
          <div className="sheet-actions">
            {confirming ? (
              <>
                <span>지울까요?</span>
                <button type="button" className="danger" onClick={() => void remove()}>
                  지우기
                </button>
                <button type="button" onClick={() => setConfirming(false)}>
                  취소
                </button>
              </>
            ) : (
              <>
                {canSend && (
                  <button type="button" onClick={() => props.onReply(selected)}>
                    답장
                  </button>
                )}
                {manageable && (
                  <button type="button" onClick={() => props.onEdit(selected)}>
                    고치기
                  </button>
                )}
                {manageable && (
                  <button type="button" className="danger" onClick={() => setConfirming(true)}>
                    지우기
                  </button>
                )}
              </>
            )}
            {actionError && <span className="danger">{actionError}</span>}
          </div>
        )
      }
      notice={props.notice}
      onNoticeClose={props.onNoticeClose}
      listRef={props.listRef}
      onScroll={props.onScroll}
      bottom={
        <div className="sheet-input">
          <span className="sheet-rownum">{inputRow}</span>
          <div className="sheet-input-cell">{props.composer}</div>
        </div>
      }
      tabsChannel={channel}
      onOpenTab={props.onOpenTab}
      status={
        props.unseen > 0 ? (
          <button type="button" className="sheet-status-new" onClick={props.onScrollToBottom}>
            새 메시지 {props.unseen}개 ↓
          </button>
        ) : (
          <span>{props.connected ? "준비" : "연결 중…"}</span>
        )
      }
    >
      {channel?.kind === "thread" && (
        // 글·스레드: 맨 위에 보고서 제목처럼 글 제목과 태그
        <div className="sheet-row sheet-title-row">
          <span className="sheet-rownum">{TITLE_ROW}</span>
          <span className="sheet-cell sheet-merged">
            {channel.locked ? "🔒 " : ""}
            {channel.name}
            {(channel.applied_tags ?? []).map((tag) => (
              <span key={tag.id} className="sheet-tag">
                {tag.emoji ? `${tag.emoji} ` : ""}
                {tag.name}
              </span>
            ))}
            <span className="sheet-title-sub">
              {channel.parent_name ?? ""}의 {forumPost ? "글" : "스레드"}
              {channel.archived ? " (보관됨, 쓰면 다시 열려요)" : ""}
            </span>
          </span>
        </div>
      )}
      <div className="sheet-row sheet-head">
        <span className="sheet-rownum">{headRow}</span>
        <span className="sheet-cell">시간</span>
        <span className="sheet-cell">보낸 사람</span>
        <span className="sheet-cell">내용</span>
        <span className="sheet-cell">{channel?.kind === "thread" ? "구분" : "반응"}</span>
        <span className="sheet-cell sheet-wide" />
        <span className="sheet-cell sheet-wide" />
      </div>
      {props.hasMore && (
        <button type="button" className="sheet-older" onClick={props.onLoadOlder} disabled={props.loadingOlder}>
          {props.loadingOlder ? "불러오는 중…" : "위 행 더 불러오기"}
        </button>
      )}
      {props.error && <p className="room-error">{props.error}</p>}
      {body}
    </SheetFrame>
  );
}

interface FrameProps {
  showBack: boolean;
  onBack: () => void;
  connected?: boolean;
  menu: ReactNode | null;
  /** 메뉴 줄 오른쪽의 진짜 버튼(스레드, 새 글) */
  menuExtra?: ReactNode;
  /** 리본 자리(없으면 장식 리본) */
  ribbon?: ReactNode;
  nameBox: string;
  formula: ReactNode;
  actions?: ReactNode;
  notice?: string;
  onNoticeClose?: () => void;
  listRef?: RefObject<HTMLDivElement | null>;
  onScroll?: () => void;
  /** 열 머리(A, B, …) 아래 행들 */
  children: ReactNode;
  /** 격자 아래 고정(입력 행 등) */
  bottom?: ReactNode;
  tabsChannel: ChannelInfo | null;
  onOpenTab?: (channel: ChannelInfo) => void;
  status: ReactNode;
  /** 열 너비를 바꿀 때(글 목록 등) */
  variant?: string;
}

/** 엑셀처럼 보이는 껍데기: 제목 줄·메뉴·리본·수식 입력줄·격자·시트 탭·상태 줄 */
export function SheetFrame(props: FrameProps) {
  return (
    <div className={props.variant ? `room sheet sheet-${props.variant}` : "room sheet"}>
      <header className="sheet-titlebar">
        {props.showBack && (
          <button type="button" className="sheet-back" onClick={props.onBack} aria-label="뒤로">
            ‹
          </button>
        )}
        <span className="sheet-doc">{document.title}</span>
        {props.connected !== undefined && (
          <span
            className={props.connected ? "dot dot-on" : "dot"}
            title={props.connected ? "실시간 연결됨" : "연결 중"}
          />
        )}
        {props.menu}
      </header>
      <div className="sheet-menus">
        {MENUS.map((name) => (
          <span key={name} className={name === "홈" ? "sheet-menu sheet-menu-on" : "sheet-menu"} aria-hidden="true">
            {name}
          </span>
        ))}
        {props.menuExtra}
      </div>
      {props.ribbon ?? (
        <div className="sheet-ribbon" aria-hidden="true">
          {RIBBON.map((name, index) => (
            <span key={index} className="sheet-ribbon-item">
              {name}
            </span>
          ))}
        </div>
      )}
      <div className="sheet-formula">
        <span className="sheet-namebox">{props.nameBox}</span>
        <span className="sheet-fx" aria-hidden="true">
          fx
        </span>
        <div className="sheet-formula-text">{props.formula}</div>
        {props.actions}
      </div>
      {props.notice && (
        <div className="room-notice" role="status">
          <span>{props.notice}</span>
          <button type="button" className="text-button" onClick={props.onNoticeClose} aria-label="안내 닫기">
            닫기
          </button>
        </div>
      )}

      <div className="sheet-grid" ref={props.listRef} onScroll={props.onScroll}>
        <div className="sheet-row sheet-colhead">
          <span className="sheet-rownum sheet-corner" />
          <span className="sheet-cell">A</span>
          <span className="sheet-cell">B</span>
          <span className="sheet-cell">C</span>
          <span className="sheet-cell">D</span>
          <span className="sheet-cell sheet-wide">E</span>
          <span className="sheet-cell sheet-wide">F</span>
        </div>
        {props.children}
      </div>

      {props.bottom}
      <SheetTabsOrNothing channel={props.tabsChannel} onOpenTab={props.onOpenTab} />
      <footer className="sheet-status">
        {props.status}
        <span className="sheet-status-right" aria-hidden="true">
          ▦ ▣ ▤ 　100%
        </span>
      </footer>
    </div>
  );
}

function SheetTabsOrNothing({
  channel,
  onOpenTab,
}: {
  channel: ChannelInfo | null;
  onOpenTab?: (channel: ChannelInfo) => void;
}) {
  if (!channel) return <nav className="sheet-tabs" />;
  return <SheetTabs channel={channel} onOpenTab={onOpenTab} />;
}

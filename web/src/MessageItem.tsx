import { type CSSProperties, memo, useState } from "react";
import MessageContent from "./MessageContent";
import { formatSize, formatTime, isDiscordMediaUrl, thumbnailUrl } from "./format";
import type { Attachment, Message, Sticker } from "./types";
import Reactions, { ReactionPickerButton } from "./Reactions";
import { isEmptyMessage, isSystemMessage, systemText } from "./systemMessage";

/** 댓글 시간: 오늘이면 시각만, 아니면 월/일도 */
function commentTime(iso: string): string {
  const date = new Date(iso);
  const today = new Date().toDateString() === date.toDateString();
  return today ? formatTime(iso) : `${date.getMonth() + 1}/${date.getDate()} ${formatTime(iso)}`;
}

export interface ReplyPreview {
  author: string;
  text: string;
}

interface Props {
  message: Message;
  /** 같은 사람이 이어서 보낸 메시지면 프로필·이름을 생략 */
  grouped: boolean;
  /** 내 메시지(오른쪽에 표시) */
  mine: boolean;
  /** 웹에서 내가 보낸 것이라 고치고 지울 수 있음 */
  manageable: boolean;
  canReply: boolean;
  /** 답장이면 원문 미리보기(목록에 없으면 null) */
  reply: ReplyPreview | null;
  selected: boolean;
  onSelect: (id: string | null) => void;
  onReply: (message: Message) => void;
  onEdit: (message: Message) => void;
  onDelete: (message: Message) => Promise<void>;
  /** 반응 달기·빼기(없으면 보기만) */
  onReact?: (message: Message, emoji: string) => void;
  myUserId?: string;
  /** 반응 고르기 창이 모임 이모지를 불러올 채널 */
  channelId?: string;
  /** bubble: 채팅 말풍선(기본), comment: 포럼 글·스레드의 게시판식 댓글, line: 메모장 한 줄 기록 */
  /** bubble 말풍선, comment 게시판 댓글, line 메모장 한 줄, row 노션 표의 한 줄 */
  layout?: "bubble" | "comment" | "line" | "row" | "para";
}

/** 본문·임베드·첨부(말풍선과 댓글이 같이 쓴다) */
export function MessageBody({ message }: { message: Message }) {
  return (
    <>
      {isEmptyMessage(message) && <span className="msg-empty">(여기서는 보여 줄 수 없는 내용이에요)</span>}
      {message.content && <MessageContent content={message.content} mentions={message.mentions} />}
      {(message.stickers ?? []).map((sticker) => (
        <div className="msg-sticker" key={sticker.id}>
          <StickerView sticker={sticker} />
        </div>
      ))}
      {message.embeds.map((embed, index) => (
        <div className="embed" key={index}>
          {embed.title && <strong>{embed.title}</strong>}
          {embed.description && <p>{embed.description}</p>}
        </div>
      ))}
      {message.attachments.map((attachment) => (
        <AttachmentView key={attachment.id} attachment={attachment} />
      ))}
    </>
  );
}

const LOTTIE_STICKER = 3;
const GIF_STICKER = 4;

/** 스티커 그림 주소. Lottie(벡터 애니메이션)는 그림 파일이 없어 null */
function stickerUrl(sticker: Sticker): string | null {
  if (!/^\d{15,21}$/.test(sticker.id) || sticker.format === LOTTIE_STICKER) return null;
  // PNG·APNG는 .png(APNG면 그대로 움직인다), GIF 스티커는 .gif
  const extension = sticker.format === GIF_STICKER ? "gif" : "png";
  return `https://media.discordapp.net/stickers/${sticker.id}.${extension}?size=160`;
}

/** 스티커: 그림으로, 그림이 없는 형식이면 이름만 */
export function StickerView({ sticker }: { sticker: Sticker }) {
  const src = stickerUrl(sticker);
  if (!src) return <span className="sticker-text">[스티커] {sticker.name}</span>;
  return <img className="sticker" src={src} alt={`[스티커] ${sticker.name}`} title={sticker.name} loading="lazy" referrerPolicy="no-referrer" />;
}

/** 글자만 보이는 테마(메모장·시트): "[사진] 파일명" 링크 */
export function AttachmentText({ attachment }: { attachment: Attachment }) {
  const isImage = attachment.content_type?.startsWith("image/") ?? false;
  const href = isDiscordMediaUrl(attachment.url) ? attachment.url : undefined;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="attachment-text">
      [{isImage ? "사진" : "파일"}] {attachment.filename}
    </a>
  );
}

export function isPicture(attachment: Attachment): boolean {
  return attachment.content_type?.startsWith("image/") ?? false;
}

/** 글자 위주 테마(메모장·시트 수식 줄): 본문 + 임베드 제목 + 첨부. pictures면 사진은 작은 그림으로 */
export function MessageTextOnly({ message, pictures = false }: { message: Message; pictures?: boolean }) {
  const shownPictures = pictures ? message.attachments.filter(isPicture) : [];
  const others = message.attachments.filter((attachment) => !shownPictures.includes(attachment));
  return (
    <>
      {message.content && <MessageContent content={message.content} mentions={message.mentions} />}
      {message.embeds.map((embed, index) => (
        <span className="embed-text" key={index}>
          {" "}
          [{embed.title || embed.description || "링크 미리보기"}]
        </span>
      ))}
      {others.map((attachment) => (
        <span key={attachment.id}>
          {" "}
          <AttachmentText attachment={attachment} />
        </span>
      ))}
      {(shownPictures.length > 0 || (message.stickers?.length ?? 0) > 0) && (
        <span className="inline-pics">
          {(message.stickers ?? []).map((sticker) => (
            <StickerView key={sticker.id} sticker={sticker} />
          ))}
          {shownPictures.map((attachment) => (
            <AttachmentView key={attachment.id} attachment={attachment} />
          ))}
        </span>
      )}
    </>
  );
}

const PLAYABLE_VIDEO = /^video\/(mp4|webm|quicktime|ogg)$/;

/** 동영상: 브라우저에서 바로 재생(디스코드 CDN에서 직접 받는다). 스포일러면 눌러야 보인다 */
function VideoView({ attachment }: { attachment: Attachment }) {
  const [revealed, setRevealed] = useState(!attachment.spoiler);
  if (!revealed) {
    return (
      <button type="button" className="attachment-file video-spoiler" onClick={() => setRevealed(true)}>
        <span className="file-name">스포일러 동영상(눌러서 보기)</span>
        <span className="file-size">{formatSize(attachment.size)}</span>
      </button>
    );
  }
  return (
    <video
      className="attachment-video"
      src={attachment.url}
      poster={isDiscordMediaUrl(attachment.proxy_url) ? `${attachment.proxy_url}?format=jpeg` : undefined}
      controls
      playsInline
      preload="metadata"
      aria-label={attachment.filename}
    />
  );
}

export function AttachmentView({ attachment }: { attachment: Attachment }) {
  const isImage = attachment.content_type?.startsWith("image/") ?? false;
  if (PLAYABLE_VIDEO.test(attachment.content_type ?? "") && isDiscordMediaUrl(attachment.url)) {
    return <VideoView attachment={attachment} />;
  }
  if (isImage && isDiscordMediaUrl(attachment.proxy_url) && isDiscordMediaUrl(attachment.url)) {
    return (
      <a href={attachment.url} target="_blank" rel="noopener noreferrer" className="attachment-image">
        <img
          src={thumbnailUrl(attachment.proxy_url, 400)}
          alt={attachment.filename}
          loading="lazy"
          referrerPolicy="no-referrer"
          className={attachment.spoiler ? "spoiler" : undefined}
        />
      </a>
    );
  }
  const href = isDiscordMediaUrl(attachment.url) ? attachment.url : undefined;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="attachment-file">
      <span className="file-name">{attachment.filename}</span>
      <span className="file-size">{formatSize(attachment.size)}</span>
    </a>
  );
}

// Word 테마: 사람마다 같은 색(본문 왼쪽 막대, 이름표)
const PARA_COLORS = ["#1f5fa8", "#a3620a", "#2f6b2f", "#8a5a2b", "#7a3e9d", "#b03a48", "#0f7b7b", "#5c5c9e"];

export function paraColor(id: string): string {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PARA_COLORS[hash % PARA_COLORS.length] ?? "#1f5fa8";
}

export function Avatar({ url, name }: { url: string | null; name: string }) {
  if (isDiscordMediaUrl(url)) {
    return <img className="avatar author-avatar" src={url} alt="" loading="lazy" referrerPolicy="no-referrer" />;
  }
  return <div className="avatar avatar-fallback author-avatar">{name.slice(0, 1)}</div>;
}

function MessageItem({
  message,
  grouped,
  mine,
  manageable,
  canReply,
  reply,
  selected,
  onSelect,
  onReply,
  onEdit,
  onDelete,
  onReact,
  myUserId = "",
  channelId = "",
  layout = "bubble",
}: Props) {
  const { author } = message;
  const [confirming, setConfirming] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  // 웹에서 보낸 메시지도 디스코드에서는 웹훅(앱)이지만, ㅁㅇㅅ에서는 사람 메시지처럼 보인다
  const isApp = (author.bot || author.webhook) && message.web_sender_id === null;
  const classes = ["msg"];
  if (grouped && !message.reference_id) classes.push("msg-grouped");
  if (mine) classes.push("msg-mine");
  const hasActions = canReply || manageable || Boolean(onReact);

  if (isSystemMessage(message)) {
    // 입장, 고정 같은 알림: 디스코드처럼 가운데 작은 글씨(표에서는 흐린 한 줄)
    if (layout === "para") {
      return (
        <p className="para para-system">
          {systemText(message)} <span className="para-system-time">{formatTime(message.created_at)}</span>
        </p>
      );
    }
    if (layout === "row") {
      return (
        <div className="db-row db-row-system" role="row">
          <div className="db-cell db-time" role="cell">
            {formatTime(message.created_at)}
          </div>
          <div className="db-cell db-author" role="cell" />
          <div className="db-cell db-content" role="cell">
            {systemText(message)}
          </div>
          <div className="db-cell db-react" role="cell" />
        </div>
      );
    }
    return layout === "line" ? (
      <div className="line-msg line-system">
        <span className="line-time">{formatTime(message.created_at)}</span>
        <span>-- {systemText(message)} --</span>
      </div>
    ) : (
      <div className="system-msg">
        <span>{systemText(message)}</span>
        <span className="system-msg-time">{formatTime(message.created_at)}</span>
      </div>
    );
  }

  const remove = async () => {
    setDeleteError("");
    try {
      await onDelete(message);
    } catch {
      setDeleteError("지우지 못했어요.");
    }
  };

  const actions = (
    <>
        {selected && (
        <div className="msg-actions">
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
              {canReply && (
                <button type="button" onClick={() => onReply(message)}>
                  답장
                </button>
              )}
              {onReact && channelId && (
                <ReactionPickerButton message={message} channelId={channelId} onReact={onReact} />
              )}
              {manageable && (
                <button type="button" onClick={() => onEdit(message)}>
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
          {deleteError && <span className="danger">{deleteError}</span>}
        </div>
      )}
    </>
  );

  if (layout === "line") {
    // 메모장: "오후 3:10 모카: 내용" 한 줄씩
    return (
      <div className={selected ? "line-msg line-msg-selected" : "line-msg"}>
        <span className="line-time">{formatTime(message.created_at)}</span>
        <div
          className="line-main"
          onClick={hasActions ? () => onSelect(selected ? null : message.id) : undefined}
        >
          {message.reference_id && (
            <span className="line-time">↪ {reply ? `${reply.author}: ${reply.text} / ` : ""}</span>
          )}
          <span className="line-name">{author.name}</span>
          {isApp && " [앱]"}: <MessageTextOnly message={message} pictures />
          {message.edited_at && <span className="line-time"> (수정됨)</span>}
          <Reactions message={message} myUserId={myUserId} onReact={onReact} compact />
          {actions}
        </div>
      </div>
    );
  }

  if (layout === "para") {
    // Word 공동 작성: 본문은 평범한 문단, 누가 썼는지는 왼쪽 색 막대와 마우스를 올리면 뜨는 이름표
    const who = `${author.name}${isApp ? " (앱)" : ""}`;
    const when = `${formatTime(message.created_at)}${message.edited_at ? " (수정됨)" : ""}`;
    const paraClasses = ["para"];
    if (selected) paraClasses.push("para-selected");
    if (grouped && !message.reference_id) paraClasses.push("para-grouped");
    if (mine) paraClasses.push("para-mine");
    return (
      <div className={paraClasses.join(" ")} style={{ "--who": paraColor(author.id) } as CSSProperties}>
        <span className="para-bar" aria-hidden="true" />
        <span className="para-flag">
          {who}
          <span className="para-flag-time"> {when}</span>
        </span>
        {message.reference_id && (
          <div className="msg-reply">
            ↪ {reply ? <><strong>{reply.author}</strong> {reply.text}</> : "이전 문단에 답장"}
          </div>
        )}
        <div
          className="para-body"
          title={`${who} ${when}`}
          onClick={hasActions ? () => onSelect(selected ? null : message.id) : undefined}
        >
          <MessageBody message={message} />
        </div>
        <Reactions message={message} myUserId={myUserId} onReact={onReact} compact />
        {selected && (
          <div className="para-meta">
            {who}, {when}
          </div>
        )}
        {actions}
      </div>
    );
  }

  if (layout === "row") {
    // 노션 표: 작성 일시, 작성자, 내용, 반응 열
    return (
      <div className={selected ? "db-row db-row-selected" : "db-row"} role="row">
        <div className="db-cell db-time" role="cell">
          {formatTime(message.created_at)}
          {message.edited_at && <span className="db-edited">수정됨</span>}
        </div>
        <div className="db-cell db-author" role="cell">
          <Avatar url={author.avatar_url} name={author.name} />
          <span className="db-author-name">{author.name}</span>
          {mine && <span className="tag tag-mine">나</span>}
          {isApp && <span className="tag">앱</span>}
        </div>
        <div className="db-cell db-content" role="cell">
          {message.reference_id && (
            <div className="msg-reply">
              ↪ {reply ? <><strong>{reply.author}</strong> {reply.text}</> : "이전 메시지에 답장"}
            </div>
          )}
          <div
            className="db-body"
            onClick={hasActions ? () => onSelect(selected ? null : message.id) : undefined}
          >
            <MessageBody message={message} />
          </div>
          {actions}
        </div>
        <div className="db-cell db-react" role="cell">
          <Reactions message={message} myUserId={myUserId} onReact={onReact} compact />
        </div>
      </div>
    );
  }

  if (layout === "comment") {
    // 게시판식 댓글: 말풍선 없이 왼쪽 정렬, 이름·시간 줄 + 내용
    return (
      <div className={selected ? "comment comment-selected" : "comment"}>
        <Avatar url={author.avatar_url} name={author.name} />
        <div className="comment-main">
          <div className="comment-head">
            <strong>{author.name}</strong>
            {mine && <span className="tag tag-mine">나</span>}
            {isApp && <span className="tag">앱</span>}
            <span className="comment-time">
              {commentTime(message.created_at)}
              {message.edited_at && " (수정됨)"}
            </span>
          </div>
          {message.reference_id && (
            <div className="msg-reply">
              ↪ {reply ? <><strong>{reply.author}</strong> {reply.text}</> : "이전 댓글에 답장"}
            </div>
          )}
          <div
            className="comment-body"
            onClick={hasActions ? () => onSelect(selected ? null : message.id) : undefined}
          >
            <MessageBody message={message} />
          </div>
          <Reactions message={message} myUserId={myUserId} onReact={onReact} />
          {actions}
        </div>
      </div>
    );
  }

  return (
    <div className={classes.join(" ")}>
      <div className="msg-side">
        {!mine && !(grouped && !message.reference_id) && <Avatar url={author.avatar_url} name={author.name} />}
      </div>
      <div className="msg-main">
        {!mine && !(grouped && !message.reference_id) && (
          <div className="msg-author">
            {author.name}
            {isApp && <span className="tag">앱</span>}
          </div>
        )}
        {message.reference_id && (
          <div className="msg-reply">
            ↪ {reply ? <><strong>{reply.author}</strong> {reply.text}</> : "이전 메시지에 답장"}
          </div>
        )}
        <div className="msg-row">
          <div
            className={selected ? "bubble bubble-selected" : "bubble"}
            onClick={hasActions ? () => onSelect(selected ? null : message.id) : undefined}
          >
            <MessageBody message={message} />
          </div>
          <span className="msg-time">
            {formatTime(message.created_at)}
            {message.edited_at && " (수정됨)"}
          </span>
        </div>
        <Reactions message={message} myUserId={myUserId} onReact={onReact} />
        {actions}
      </div>
    </div>
  );
}

export default memo(MessageItem);

import { memo, useState } from "react";
import MessageContent from "./MessageContent";
import { formatSize, formatTime, isDiscordMediaUrl, thumbnailUrl } from "./format";
import type { Attachment, Message } from "./types";

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
  /** bubble: 채팅 말풍선(기본), comment: 포럼 글·스레드의 게시판식 댓글 */
  layout?: "bubble" | "comment";
}

/** 본문·임베드·첨부(말풍선과 댓글이 같이 쓴다) */
export function MessageBody({ message }: { message: Message }) {
  return (
    <>
      {message.content && <MessageContent content={message.content} mentions={message.mentions} />}
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

export function AttachmentView({ attachment }: { attachment: Attachment }) {
  const isImage = attachment.content_type?.startsWith("image/") ?? false;
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

export function Avatar({ url, name }: { url: string | null; name: string }) {
  if (isDiscordMediaUrl(url)) {
    return <img className="avatar" src={url} alt="" loading="lazy" referrerPolicy="no-referrer" />;
  }
  return <div className="avatar avatar-fallback">{name.slice(0, 1)}</div>;
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
  const hasActions = canReply || manageable;

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
        {actions}
      </div>
    </div>
  );
}

export default memo(MessageItem);

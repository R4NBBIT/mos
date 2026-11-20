import { memo } from "react";
import MessageContent from "./MessageContent";
import { formatSize, formatTime, isDiscordMediaUrl, thumbnailUrl } from "./format";
import type { Attachment, Message } from "./types";

interface Props {
  message: Message;
  /** 같은 사람이 이어서 보낸 메시지면 프로필·이름을 생략 */
  grouped: boolean;
}

function AttachmentView({ attachment }: { attachment: Attachment }) {
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

function Avatar({ url, name }: { url: string | null; name: string }) {
  if (isDiscordMediaUrl(url)) {
    return <img className="avatar" src={url} alt="" loading="lazy" referrerPolicy="no-referrer" />;
  }
  return <div className="avatar avatar-fallback">{name.slice(0, 1)}</div>;
}

function MessageItem({ message, grouped }: Props) {
  const { author } = message;
  return (
    <div className={grouped ? "msg msg-grouped" : "msg"}>
      <div className="msg-side">{!grouped && <Avatar url={author.avatar_url} name={author.name} />}</div>
      <div className="msg-main">
        {!grouped && (
          <div className="msg-author">
            {author.name}
            {(author.bot || author.webhook) && <span className="tag">앱</span>}
          </div>
        )}
        <div className="msg-row">
          <div className="bubble">
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
          </div>
          <span className="msg-time">
            {formatTime(message.created_at)}
            {message.edited_at && " (수정됨)"}
          </span>
        </div>
      </div>
    </div>
  );
}

export default memo(MessageItem);

import type { ReactNode } from "react";
import type { Mentions } from "./types";

// 디스코드 본문 속 특수 코드:
//   <:이름:ID> <a:이름:ID>  사용자 이모지(a는 움직이는 것)
//   <@ID> <@!ID>           사람 멘션
//   <@&ID>                 역할 멘션
//   <#ID>                  채널 링크
//   <t:초> <t:초:형식>      시간 표시
// ID는 숫자만 받으므로 이모지 주소를 만들 때 다른 값이 끼어들 수 없다.
const tokenPattern =
  /<(a?):([A-Za-z0-9_]{1,32}):(\d{15,21})>|<@!?(\d{15,21})>|<@&(\d{15,21})>|<#(\d{15,21})>|<t:(-?\d{1,13})(?::([tTdDfFR]))?>/g;

const emojiOnlyLimit = 27; // 디스코드처럼 이모지만 있으면 크게(최대 27개)

const timestampFormats: Record<string, Intl.DateTimeFormatOptions> = {
  t: { hour: "numeric", minute: "2-digit" },
  T: { hour: "numeric", minute: "2-digit", second: "2-digit" },
  d: { year: "numeric", month: "2-digit", day: "2-digit" },
  D: { year: "numeric", month: "long", day: "numeric" },
  f: { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" },
  F: {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
  },
};

const relativeFormat = new Intl.RelativeTimeFormat("ko-KR", { numeric: "auto" });
const relativeUnits: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

function formatTimestamp(seconds: number, style: string): string {
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return "";
  if (style === "R") {
    const diff = (date.getTime() - Date.now()) / 1000;
    for (const [unit, size] of relativeUnits) {
      if (Math.abs(diff) >= size || unit === "second") {
        return relativeFormat.format(Math.round(diff / size), unit);
      }
    }
  }
  return new Intl.DateTimeFormat("ko-KR", timestampFormats[style] ?? timestampFormats.f).format(date);
}

function emojiUrl(id: string, animated: boolean): string {
  return `https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "webp"}?size=96`;
}

function isEmojiOnly(content: string): boolean {
  let custom = 0;
  const rest = content.replace(tokenPattern, (match: string, _animated: string, name?: string) => {
    if (!name) return match;
    custom += 1;
    return "";
  });
  const unicode = rest.match(/\p{Extended_Pictographic}/gu)?.length ?? 0;
  const leftover = rest.replace(
    /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\ufe0f\u20e3\s]/gu,
    "",
  );
  const total = custom + unicode;
  return leftover === "" && total > 0 && total <= emojiOnlyLimit;
}

interface Props {
  content: string;
  mentions: Mentions;
}

export default function MessageContent({ content, mentions }: Props) {
  const jumbo = isEmojiOnly(content);
  const parts: ReactNode[] = [];
  let last = 0;
  let key = 0;

  for (const match of content.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(content.slice(last, index));
    last = index + match[0].length;
    const [raw, animated, emojiName, emojiId, userId, roleId, channelId, timeValue, timeStyle] = match;

    if (emojiId) {
      parts.push(
        <img
          key={key++}
          className={jumbo ? "emoji emoji-jumbo" : "emoji"}
          src={emojiUrl(emojiId, animated === "a")}
          alt={`:${emojiName}:`}
          title={`:${emojiName}:`}
          loading="lazy"
          referrerPolicy="no-referrer"
        />,
      );
    } else if (userId) {
      parts.push(
        <span key={key++} className="mention">
          @{mentions.users[userId] ?? "알 수 없는 사용자"}
        </span>,
      );
    } else if (roleId) {
      parts.push(
        <span key={key++} className="mention">
          @{mentions.roles[roleId] ?? "알 수 없는 역할"}
        </span>,
      );
    } else if (channelId) {
      parts.push(
        <span key={key++} className="mention">
          #{mentions.channels[channelId] ?? "알 수 없는 채널"}
        </span>,
      );
    } else if (timeValue) {
      const text = formatTimestamp(Number(timeValue), timeStyle ?? "f");
      parts.push(
        <time key={key++} className="timestamp">
          {text || raw}
        </time>,
      );
    } else {
      parts.push(raw);
    }
  }
  if (last < content.length) parts.push(content.slice(last));

  return <p className={jumbo ? "msg-text msg-jumbo" : "msg-text"}>{parts}</p>;
}

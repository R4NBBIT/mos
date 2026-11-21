import { type ReactNode, useState } from "react";
import type { Mentions } from "./types";

// 디스코드 본문 속 특수 코드:
//   <:이름:ID> <a:이름:ID>  사용자 이모지(a는 움직이는 것)
//   <@ID> <@!ID>           사람 멘션
//   <@&ID>                 역할 멘션
//   <#ID>                  채널 링크
//   <t:초> <t:초:형식>      시간 표시
// ID는 숫자만 받으므로 이모지 주소를 만들 때 다른 값이 끼어들 수 없다.
const tokenPattern =
  /<(a?):([A-Za-z0-9_]{1,32}):(\d{15,21})>|<@!?(\d{15,21})>|<@&(\d{15,21})>|<#(\d{15,21})>|<t:(-?\d{1,13})(?::([tTdDfFR]))?>|<\/([\p{L}\p{N}_-]{1,32}(?: [\p{L}\p{N}_-]{1,32}){0,2}):\d{15,21}>/gu;

const emojiOnlyLimit = 27; // 디스코드처럼 이모지만 있으면 크게(최대 27개)

const timestampFormats: Record<string, Intl.DateTimeFormatOptions> = {
  t: { hour: "numeric", minute: "2-digit" },
  T: { hour: "numeric", minute: "2-digit", second: "2-digit" },
  d: { year: "numeric", month: "2-digit", day: "2-digit" },
  D: { year: "numeric", month: "long", day: "numeric" },
  f: {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  },
  F: {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
  },
};

const relativeFormat = new Intl.RelativeTimeFormat("ko-KR", {
  numeric: "auto",
});
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
  return new Intl.DateTimeFormat(
    "ko-KR",
    timestampFormats[style] ?? timestampFormats.f,
  ).format(date);
}

// 디스코드 권장 주소: 모두 webp, 움직이는 이모지는 animated=true(.gif는 요즘 올린 것에서 안 나올 수 있다)
function emojiUrl(id: string, animated: boolean): string {
  return `https://cdn.discordapp.com/emojis/${id}.webp?size=96${animated ? "&animated=true" : ""}`;
}

function isEmojiOnly(content: string): boolean {
  let custom = 0;
  const rest = content.replace(
    tokenPattern,
    (match: string, _animated: string, name?: string) => {
      if (!name) return match;
      custom += 1;
      return "";
    },
  );
  const unicode = rest.match(/\p{Extended_Pictographic}/gu)?.length ?? 0;
  const leftover = rest.replace(
    /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\ufe0f\u20e3\s]/gu,
    "",
  );
  const total = custom + unicode;
  return leftover === "" && total > 0 && total <= emojiOnlyLimit;
}

// ------------------------------------------------------------ 서식(디스코드 마크다운)
// HTML로 넣지 않고 React 요소로만 만든다(XSS 방지). 링크는 http·https만.

type Ctx = { mentions: Mentions; jumbo: boolean; key: { n: number } };

const inlinePattern = new RegExp(
  [
    String.raw`\\([\\*_~|` + "`" + String.raw`>#\-\[\]()])`, // 1 \* 같은 글자 그대로
    "`([^`\\n]+)`", // 2 코드
    String.raw`\|\|([\s\S]+?)\|\|`, // 3 스포일러
    String.raw`\*\*([\s\S]+?)\*\*`, // 4 굵게
    String.raw`__([\s\S]+?)__`, // 5 밑줄
    String.raw`~~([\s\S]+?)~~`, // 6 취소선
    String.raw`\*([^*\s](?:[^*\n]*?[^*\s])?)\*`, // 7 기울임 *
    String.raw`(?<![\p{L}\p{N}])_([^_\s](?:[^_\n]*?[^_\s])?)_(?![\p{L}\p{N}])`, // 8 기울임 _
    String.raw`\[([^\]\n]{1,200})\]\(<?(https?:\/\/[^\s)>]{1,2000})>?\)`, // 9,10 [글](주소)
    String.raw`<(https?:\/\/[^\s>]{1,2000})>`, // 11 <주소>
    String.raw`(https?:\/\/[^\s<]{1,2000}[^\s<.,:;"')\]!?])`, // 12 주소
  ].join("|"),
  "gu",
);

function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

const discordLinkPattern =
  /^https:\/\/(?:www\.|ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(\d{15,21})\/(\d{15,21})(?:\/\d{15,21})?\/?$/;

/** 디스코드 채널·메시지 주소면 ㅁㅇㅅ 화면 주소(#/g/모임/c/채널), 아니면 null */
export function insideRoute(href: string): string | null {
  const match = discordLinkPattern.exec(href);
  return match ? `#/g/${match[1]}/c/${match[2]}` : null;
}

function Link({
  href,
  children,
  title,
}: {
  href: string;
  children: ReactNode;
  title?: string;
}) {
  // 디스코드 채널·메시지 주소는 디스코드를 열지 않고 ㅁㅇㅅ 안의 그 채널로
  const inside = insideRoute(href);
  if (inside) {
    return (
      <a className="md-link" href={inside} onClick={(event) => event.stopPropagation()}>
        {children}
      </a>
    );
  }
  return (
    <a
      className="md-link"
      href={href}
      title={title}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </a>
  );
}

function Spoiler({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  return (
    <span
      className={shown ? "md-spoiler md-spoiler-shown" : "md-spoiler"}
      role="button"
      tabIndex={0}
      onClick={(event) => {
        event.stopPropagation();
        setShown(true);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") setShown(true);
      }}
    >
      {children}
    </span>
  );
}

/** 이모지·멘션·채널·시간 코드 */
function renderTokens(text: string, ctx: Ctx): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    last = index + match[0].length;
    const [
      raw,
      animated,
      emojiName,
      emojiId,
      userId,
      roleId,
      channelId,
      timeValue,
      timeStyle,
      commandName,
    ] = match;
    const key = ctx.key.n++;
    if (emojiId) {
      parts.push(
        <img
          key={key}
          className={ctx.jumbo ? "emoji emoji-jumbo" : "emoji"}
          src={emojiUrl(emojiId, animated === "a")}
          alt={`:${emojiName}:`}
          title={`:${emojiName}:`}
          loading="lazy"
          referrerPolicy="no-referrer"
        />,
      );
    } else if (userId) {
      parts.push(
        <span key={key} className="mention">
          @{ctx.mentions.users[userId] ?? "알 수 없는 사용자"}
        </span>,
      );
    } else if (roleId) {
      parts.push(
        <span key={key} className="mention">
          @{ctx.mentions.roles[roleId] ?? "알 수 없는 역할"}
        </span>,
      );
    } else if (channelId) {
      parts.push(
        <span key={key} className="mention">
          #{ctx.mentions.channels[channelId] ?? "알 수 없는 채널"}
        </span>,
      );
    } else if (timeValue) {
      const formatted = formatTimestamp(Number(timeValue), timeStyle ?? "f");
      parts.push(
        <time key={key} className="timestamp">
          {formatted || raw}
        </time>,
      );
    } else if (commandName) {
      // 명령 버튼(디스코드 앱에서는 눌러 실행). 여기서는 실행할 수 없어 이름만
      parts.push(
        <span key={key} className="mention" title="디스코드 앱에서 쓰는 명령이에요">
          /{commandName}
        </span>,
      );
    } else {
      parts.push(raw);
    }
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** 줄 안의 서식 */
function renderInline(text: string, ctx: Ctx, depth = 0): ReactNode[] {
  if (depth > 8) return renderTokens(text, ctx); // 너무 깊은 중첩은 그대로
  const parts: ReactNode[] = [];
  let last = 0;
  const pattern = new RegExp(inlinePattern.source, inlinePattern.flags);
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(...renderTokens(text.slice(last, index), ctx));
    last = index + match[0].length;
    const key = ctx.key.n++;
    const inner = (value: string) => renderInline(value, ctx, depth + 1);
    const [
      raw,
      escaped,
      code,
      spoiler,
      bold,
      underline,
      strike,
      italicStar,
      italicUnder,
      label,
      labelUrl,
      angleUrl,
      bareUrl,
    ] = match;
    if (escaped !== undefined) parts.push(escaped);
    else if (code !== undefined)
      parts.push(
        <code key={key} className="md-code">
          {code}
        </code>,
      );
    else if (spoiler !== undefined)
      parts.push(<Spoiler key={key}>{inner(spoiler)}</Spoiler>);
    else if (bold !== undefined)
      parts.push(<strong key={key}>{inner(bold)}</strong>);
    else if (underline !== undefined)
      parts.push(<u key={key}>{inner(underline)}</u>);
    else if (strike !== undefined) parts.push(<s key={key}>{inner(strike)}</s>);
    else if (italicStar !== undefined)
      parts.push(<em key={key}>{inner(italicStar)}</em>);
    else if (italicUnder !== undefined)
      parts.push(<em key={key}>{inner(italicUnder)}</em>);
    else if (label !== undefined && labelUrl !== undefined) {
      const href = safeHref(labelUrl);
      parts.push(
        href ? (
          <Link key={key} href={href} title={href}>
            {inner(label)}
          </Link>
        ) : (
          raw
        ),
      );
    } else {
      const url = angleUrl ?? bareUrl ?? "";
      const href = safeHref(url);
      parts.push(
        href ? (
          <Link key={key} href={href}>
            {url}
          </Link>
        ) : (
          raw
        ),
      );
    }
  }
  if (last < text.length) parts.push(...renderTokens(text.slice(last), ctx));
  return parts;
}

/** 줄 단위 서식: 인용(> , >>> ), 제목(#), 작은 글씨(-#), 목록(- , * ) */
function renderLines(text: string, ctx: Ctx): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = text.split("\n");
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) {
      out.push(
        <span key={ctx.key.n++}>
          {renderInline(paragraph.join("\n"), ctx)}
        </span>,
      );
      paragraph = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith(">>> ")) {
      flush();
      const rest = [line.slice(4), ...lines.slice(i + 1)].join("\n");
      out.push(
        <blockquote key={ctx.key.n++} className="md-quote">
          {renderInline(rest, ctx)}
        </blockquote>,
      );
      return out;
    }
    if (line.startsWith("> ") || line === ">") {
      flush();
      const quoted: string[] = [];
      while (
        i < lines.length &&
        ((lines[i] ?? "").startsWith("> ") || lines[i] === ">")
      ) {
        quoted.push((lines[i] ?? "").slice(2));
        i++;
      }
      i--;
      out.push(
        <blockquote key={ctx.key.n++} className="md-quote">
          {renderInline(quoted.join("\n"), ctx)}
        </blockquote>,
      );
      continue;
    }
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    if (heading?.[1] && heading[2]) {
      flush();
      out.push(
        <span key={ctx.key.n++} className={`md-h md-h${heading[1].length}`}>
          {renderInline(heading[2], ctx)}
        </span>,
      );
      continue;
    }
    const subtext = /^-# (.+)$/.exec(line);
    if (subtext?.[1]) {
      flush();
      out.push(
        <span key={ctx.key.n++} className="md-subtext">
          {renderInline(subtext[1], ctx)}
        </span>,
      );
      continue;
    }
    if (/^\s*[-*] .+/.test(line)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*] .+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*[-*] /, ""));
        i++;
      }
      i--;
      out.push(
        <ul key={ctx.key.n++} className="md-list">
          {items.map((item, index) => (
            <li key={index}>{renderInline(item, ctx)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return out;
}

/** 코드 블록(```)을 먼저 떼어 내고 나머지에 서식 적용 */
function renderMarkdown(content: string, ctx: Ctx): ReactNode[] {
  const out: ReactNode[] = [];
  const fence = /```(?:([\w+#.-]{1,20})\n)?([\s\S]*?)```/g;
  let last = 0;
  for (const match of content.matchAll(fence)) {
    const index = match.index ?? 0;
    const before = content.slice(last, index).replace(/\n$/, "");
    if (before) out.push(...renderLines(before, ctx));
    out.push(
      <pre key={ctx.key.n++} className="md-codeblock">
        <code>{(match[2] ?? "").replace(/^\n/, "").replace(/\n$/, "")}</code>
      </pre>,
    );
    last = index + match[0].length;
    if (content[last] === "\n") last++;
  }
  const rest = content.slice(last);
  if (rest) out.push(...renderLines(rest, ctx));
  return out;
}

interface Props {
  content: string;
  mentions: Mentions;
}

export default function MessageContent({ content, mentions }: Props) {
  const jumbo = isEmojiOnly(content);
  const ctx: Ctx = { mentions, jumbo, key: { n: 0 } };
  return (
    <div className={jumbo ? "msg-text msg-jumbo" : "msg-text"}>
      {renderMarkdown(content, ctx)}
    </div>
  );
}

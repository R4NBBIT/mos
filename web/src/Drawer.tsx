// 채팅방 서랍: 메시지 찾기, 고정된 메시지, 사진, 파일, 이 채널을 볼 수 있는 사람.
// PC는 오른쪽 작업 창, 휴대폰은 화면 전체. 항목을 누르면 대화에서 그 메시지로 간다.
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, fetchFileMessages, fetchGroupMembers, fetchPinnedMessages, searchMessages } from "./api";
import { isDiscordMediaUrl, formatSize, thumbnailUrl } from "./format";
import { useLook } from "./lookContext";
import { Avatar } from "./MessageItem";
import { plainText } from "./SheetView";
import type { Attachment, ChannelInfo, GroupMember, Message } from "./types";

export type DrawerTab = "search" | "pins" | "photos" | "files" | "people";

/** 테마마다 탭 이름. 마지막 탭은 문서 프로그램이면 '공유 대상', 나머지는 '멤버' */
function tabsFor(theme: string): { id: DrawerTab; label: string }[] {
  const people = theme === "sheet" || theme === "memo" || theme === "word" ? "공유 대상" : "멤버";
  return [
    { id: "search", label: "찾기" },
    { id: "pins", label: "고정" },
    { id: "photos", label: "사진" },
    { id: "files", label: "파일" },
    { id: "people", label: people },
  ];
}

/** 테마마다 그 프로그램의 작업 창 이름 */
export function drawerTitle(theme: string): string {
  if (theme === "note") return "검색";
  if (theme === "word") return "탐색";
  if (theme === "sheet" || theme === "memo") return "찾기";
  return "서랍";
}

const SEARCH_DELAY_MS = 350;
const SNIPPET_BEFORE = 30;
const SNIPPET_MAX = 140;

const whenFormat = new Intl.DateTimeFormat("ko-KR", {
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function when(iso: string): string {
  return whenFormat.format(new Date(iso));
}

function failText(caught: unknown): string {
  if (caught instanceof ApiError && caught.status === 429) return "너무 자주 찾았어요. 잠시 뒤에 다시 해 주세요.";
  if (caught instanceof ApiError && caught.status === 502) return "디스코드에서 받아 오지 못했어요. 잠시 뒤에 다시 해 주세요.";
  return "불러오지 못했어요.";
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 찾은 낱말을 굵게. 긴 글은 처음 찾은 곳 앞뒤만 */
function Highlighted({ text, words }: { text: string; words: string[] }) {
  const pattern = words.length ? new RegExp(`(${words.map(escapeRegExp).join("|")})`, "gi") : null;
  let shown = text;
  if (pattern && text.length > SNIPPET_MAX) {
    const first = text.search(pattern);
    const start = Math.max(0, first - SNIPPET_BEFORE);
    shown = (start > 0 ? "…" : "") + text.slice(start, start + SNIPPET_MAX) + (start + SNIPPET_MAX < text.length ? "…" : "");
  } else if (text.length > SNIPPET_MAX) {
    shown = `${text.slice(0, SNIPPET_MAX)}…`;
  }
  if (!pattern) return <>{shown}</>;
  const lowered = words.map((word) => word.toLocaleLowerCase("ko"));
  return (
    <>
      {shown.split(pattern).map((part, index) =>
        lowered.includes(part.toLocaleLowerCase("ko")) ? <mark key={index}>{part}</mark> : part,
      )}
    </>
  );
}

function summary(message: Message): string {
  const text = plainText(message);
  if (text) return text;
  if (message.attachments.length) return message.attachments.map((item) => `[${item.filename}]`).join(" ");
  if (message.stickers?.length) return "[스티커]";
  return "(내용 없음)";
}

/** 찾은 메시지, 고정된 메시지 한 줄 */
function MessageHit({ message, words = [], onJump }: { message: Message; words?: string[]; onJump: (id: string) => void }) {
  return (
    <li>
      <button type="button" className="drawer-hit" onClick={() => onJump(message.id)}>
        <span className="drawer-hit-head">
          <strong>{message.author.name}</strong>
          <time dateTime={message.created_at}>{when(message.created_at)}</time>
        </span>
        <span className="drawer-hit-text">
          <Highlighted text={summary(message)} words={words} />
        </span>
      </button>
    </li>
  );
}

function SearchTab({ channel, onJump, onAuthLost }: TabProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const [days, setDays] = useState(90);
  const asked = useRef("");
  const words = useMemo(() => query.trim().split(/\s+/).filter(Boolean).slice(0, 5), [query]);

  const run = async (text: string, before?: string) => {
    asked.current = text;
    setState("loading");
    try {
      const page = await searchMessages(channel.id, text, before);
      if (asked.current !== text) return; // 그 사이 다른 말로 찾음
      setDays(page.days);
      setResults((current) => (before ? [...current, ...page.messages] : page.messages));
      setHasMore(page.has_more);
      setState("done");
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onAuthLost();
      setError(failText(caught));
      setState("error");
    }
  };

  useEffect(() => {
    const text = query.trim();
    if (!text) {
      asked.current = "";
      setResults([]);
      setState("idle");
      return;
    }
    const timer = window.setTimeout(() => void run(text), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
    // run은 매번 새로 만들어지지만 query가 바뀔 때만 찾는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, channel.id]);

  return (
    <>
      <div className="drawer-search" role="search">
        <input
          type="search"
          value={query}
          maxLength={100}
          placeholder="이 채널에서 찾을 말"
          aria-label="이 채널에서 찾을 말"
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <p className="drawer-note">최근 {days}일 안의 메시지만 찾을 수 있어요. 내용, 보낸 사람, 파일 이름에서 찾아요.</p>
      {state === "error" && <p className="drawer-empty">{error}</p>}
      {state === "done" && results.length === 0 && <p className="drawer-empty">‘{query.trim()}’ 들어간 메시지가 없어요.</p>}
      {results.length > 0 && (
        <ul className="drawer-list" aria-label="찾은 메시지">
          {results.map((message) => (
            <MessageHit key={message.id} message={message} words={words} onJump={onJump} />
          ))}
        </ul>
      )}
      {state === "loading" && <p className="drawer-empty">찾는 중…</p>}
      {state === "done" && hasMore && (
        <button
          type="button"
          className="text-button drawer-more"
          onClick={() => void run(query.trim(), results[results.length - 1]?.id)}
        >
          더 찾기
        </button>
      )}
    </>
  );
}

function PinsTab({ channel, onJump, onAuthLost }: TabProps) {
  const [pins, setPins] = useState<Message[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let stopped = false;
    fetchPinnedMessages(channel.id)
      .then((value) => {
        if (!stopped) setPins(value.messages);
      })
      .catch((caught: unknown) => {
        if (stopped) return;
        if (caught instanceof ApiError && caught.status === 401) return onAuthLost();
        setError(failText(caught));
      });
    return () => {
      stopped = true;
    };
  }, [channel.id, onAuthLost]);
  if (error) return <p className="drawer-empty">{error}</p>;
  if (!pins) return <p className="drawer-empty">불러오는 중…</p>;
  if (pins.length === 0) return <p className="drawer-empty">고정된 메시지가 없어요. 고정은 디스코드 앱에서 할 수 있어요.</p>;
  return (
    <ul className="drawer-list" aria-label="고정된 메시지">
      {pins.map((message) => (
        <MessageHit key={message.id} message={message} onJump={onJump} />
      ))}
    </ul>
  );
}

interface FileItem {
  message: Message;
  attachment: Attachment;
}

/** 사진 탭과 파일 탭이 같이 쓰는 목록(첨부가 있는 메시지, 최신부터) */
function useFiles(channelId: string, onAuthLost: () => void) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [state, setState] = useState<"loading" | "done" | "error">("loading");
  const [error, setError] = useState("");
  const load = async (before?: string) => {
    setState("loading");
    try {
      const page = await fetchFileMessages(channelId, before);
      setMessages((current) => (before ? [...current, ...page.messages] : page.messages));
      setHasMore(page.has_more);
      setState("done");
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) return onAuthLost();
      setError(failText(caught));
      setState("error");
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);
  const items: FileItem[] = messages.flatMap((message) =>
    message.attachments.map((attachment) => ({ message, attachment })),
  );
  return {
    items,
    hasMore,
    state,
    error,
    more: () => void load(messages[messages.length - 1]?.id),
  };
}

type Files = ReturnType<typeof useFiles>;

function MoreButton({ files }: { files: Files }) {
  if (files.state === "loading") return <p className="drawer-empty">불러오는 중…</p>;
  if (files.state === "error") return <p className="drawer-empty">{files.error}</p>;
  if (!files.hasMore) return null;
  return (
    <button type="button" className="text-button drawer-more" onClick={files.more}>
      더 보기
    </button>
  );
}

const isImage = (item: FileItem) => (item.attachment.content_type ?? "").startsWith("image/");

function PhotosTab({ files, onJump }: { files: Files; onJump: (id: string) => void }) {
  const hideMedia = useLook().settings.media_view === "hidden";
  const photos = files.items.filter(
    (item) => isImage(item) && isDiscordMediaUrl(item.attachment.proxy_url),
  );
  return (
    <>
      {files.state === "done" && photos.length === 0 && <p className="drawer-empty">받아 둔 사진이 없어요.</p>}
      {photos.length > 0 &&
        (hideMedia ? (
          // 설정에서 사진 숨기기: 그림 대신 이름만
          <ul className="drawer-list">
            {photos.map(({ message, attachment }) => (
              <li key={attachment.id}>
                <button type="button" className="drawer-hit" onClick={() => onJump(message.id)}>
                  <span className="drawer-hit-head">
                    <strong>{message.author.name}</strong>
                    <time dateTime={message.created_at}>{when(message.created_at)}</time>
                  </span>
                  <span className="drawer-hit-text">[사진] {attachment.filename}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="drawer-photos">
            {photos.map(({ message, attachment }) => (
              <PhotoTile
                key={attachment.id}
                attachment={attachment}
                title={`${message.author.name}, ${when(message.created_at)}`}
                onClick={() => onJump(message.id)}
              />
            ))}
          </div>
        ))}
      <MoreButton files={files} />
    </>
  );
}

/** 사진 한 칸. 못 받으면(디스코드에서 지운 사진 등) 깨진 그림 대신 파일 이름 */
function PhotoTile({ attachment, title, onClick }: { attachment: Attachment; title: string; onClick: () => void }) {
  const [broken, setBroken] = useState(false);
  return (
    <button type="button" className="drawer-photo" title={title} onClick={onClick}>
      {broken ? (
        <span className="drawer-photo-name">{attachment.filename}</span>
      ) : (
        <img
          src={thumbnailUrl(attachment.proxy_url, 240)}
          alt={attachment.filename}
          loading="lazy"
          referrerPolicy="no-referrer"
          className={attachment.spoiler ? "spoiler" : undefined}
          onError={() => setBroken(true)}
        />
      )}
    </button>
  );
}

function FilesTab({ files, onJump }: { files: Files; onJump: (id: string) => void }) {
  const others = files.items.filter((item) => !isImage(item));
  return (
    <>
      {files.state === "done" && others.length === 0 && <p className="drawer-empty">받아 둔 파일이 없어요.</p>}
      {others.length > 0 && (
        <ul className="drawer-list" aria-label="파일">
          {others.map(({ message, attachment }) => (
            <li key={attachment.id} className="drawer-file">
              <button type="button" className="drawer-hit" onClick={() => onJump(message.id)}>
                <span className="drawer-hit-head">
                  <strong className="drawer-file-name">{attachment.filename}</strong>
                  <span>{formatSize(attachment.size)}</span>
                </span>
                <span className="drawer-hit-text">
                  {message.author.name}, {when(message.created_at)}
                </span>
              </button>
              {isDiscordMediaUrl(attachment.url) && (
                <a
                  className="drawer-download"
                  href={attachment.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`${attachment.filename} 받기`}
                >
                  받기
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
      <MoreButton files={files} />
    </>
  );
}

function PeopleTab({ channel, onAuthLost }: TabProps) {
  const [people, setPeople] = useState<{ list: GroupMember[]; all: number } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let stopped = false;
    fetchGroupMembers(channel.group_id)
      .then((value) => {
        if (stopped) return;
        const allowed = value.restricted[channel.parent_id ?? channel.id];
        const list = allowed ? value.members.filter((member) => allowed.includes(member.id)) : value.members;
        setPeople({ list, all: value.members.length });
      })
      .catch((caught: unknown) => {
        if (stopped) return;
        if (caught instanceof ApiError && caught.status === 401) return onAuthLost();
        setError(failText(caught));
      });
    return () => {
      stopped = true;
    };
  }, [channel.group_id, channel.id, channel.parent_id, onAuthLost]);
  if (error) return <p className="drawer-empty">{error}</p>;
  if (!people) return <p className="drawer-empty">불러오는 중…</p>;
  return (
    <>
      <p className="drawer-note">
        {people.list.length === people.all
          ? `서버 멤버 ${people.all}명 모두 이 채널을 볼 수 있어요.`
          : `서버 멤버 ${people.all}명 중 ${people.list.length}명만 이 채널을 볼 수 있어요.`}
      </p>
      <ul className="drawer-people">
        {people.list.map((member) => (
          <li key={member.id} className="member-row" title={member.name}>
            <Avatar url={member.avatar_url} name={member.name} />
            <span className="member-name">{member.name}</span>
            {member.bot && <span className="member-bot">봇</span>}
          </li>
        ))}
      </ul>
    </>
  );
}

interface TabProps {
  channel: ChannelInfo;
  onJump: (id: string) => void;
  onAuthLost: () => void;
}

export default function Drawer({
  channel,
  tab,
  onTab,
  onJump,
  onClose,
  onAuthLost,
}: TabProps & {
  tab: DrawerTab;
  onTab: (tab: DrawerTab) => void;
  onClose: () => void;
}) {
  const theme = useLook().settings.theme;
  const files = useFiles(channel.id, onAuthLost);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  let body: ReactNode;
  if (tab === "search") body = <SearchTab channel={channel} onJump={onJump} onAuthLost={onAuthLost} />;
  else if (tab === "pins") body = <PinsTab channel={channel} onJump={onJump} onAuthLost={onAuthLost} />;
  else if (tab === "photos") body = <PhotosTab files={files} onJump={onJump} />;
  else if (tab === "files") body = <FilesTab files={files} onJump={onJump} />;
  else body = <PeopleTab channel={channel} onJump={onJump} onAuthLost={onAuthLost} />;
  return (
    <aside className="drawer" aria-label={drawerTitle(theme)}>
      <header className="drawer-header">
        <strong>{drawerTitle(theme)}</strong>
        <button type="button" className="drawer-close" onClick={onClose} aria-label="닫기">
          ×
        </button>
      </header>
      <div className="drawer-tabs" role="tablist">
        {tabsFor(theme).map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? "drawer-tab drawer-tab-on" : "drawer-tab"}
            onClick={() => onTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="drawer-body" role="tabpanel">
        {body}
      </div>
    </aside>
  );
}

import { Collapse, usePresence } from "./motion";
import BackIcon from "./BackIcon";
import SplitToggle from "./SplitToggle";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, fetchGroupChannels, fetchGroupMembers, fetchGroups, fetchGroupVoice, setPinned } from "./api";
import { type ListSkin, listSkin, lockIcon } from "./listSkin";
import { useLook } from "./lookContext";
import { applyOrder, channelSections, OrderBar, ResetOrder, Sortable } from "./listOrder";
import { Avatar } from "./MessageItem";
import type {
  ChannelInfo,
  Group,
  GroupChannels,
  GroupList as GroupListData,
  GroupMembers,
  VoiceChannel,
} from "./types";
import { useVoiceChannels } from "./voice";
import { VoiceRow, withVoice } from "./voiceParts";
import { FoldChevron, HiddenFolder, hiddenCounts, HideButton, ListSearch, nameMatches, useHidden } from "./listFind";

const RETRY_MAX_MS = 15_000;
const REFRESH_MS = 20_000; // 안 읽음 숫자를 새로 받는 간격(목록을 보고 있을 때만)

type Load<T> = { state: "loading" } | { state: "ok"; value: T } | { state: "error"; message: string };

/**
 * 목록 불러오기. 봇이 막 켜져 503이면 붙을 때까지 다시 묻고,
 * 받은 뒤에는 REFRESH_MS마다 조용히 새로 받는다(실패해도 보던 목록은 그대로).
 */
function useLoad<T>(
  loader: () => Promise<T>,
  deps: unknown[],
  onAuthLost: () => void,
): [Load<T>, () => void] {
  const [load, setLoad] = useState<Load<T>>({ state: "loading" });
  const [tick, setTick] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const reload = useCallback(() => setTick((value) => value + 1), []);
  const depsKey = JSON.stringify(deps);

  useEffect(() => {
    setLoad({ state: "loading" });
  }, [depsKey]);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const attempt = async (delayMs: number) => {
      try {
        const value = await loaderRef.current();
        if (stopped) return;
        setLoad({ state: "ok", value });
        timer = window.setTimeout(() => {
          if (document.visibilityState === "visible") void attempt(1000);
          else setTick((value) => value + 1);
        }, REFRESH_MS);
      } catch (caught) {
        if (stopped) return;
        if (caught instanceof ApiError && caught.status === 401) {
          onAuthLost();
          return;
        }
        if (caught instanceof ApiError && caught.status === 404) {
          setLoad({ state: "error", message: "볼 수 없는 서버예요. 목록으로 돌아가 주세요." });
          return;
        }
        setLoad((current) =>
          current.state === "ok"
            ? current
            : {
                state: "error",
                message:
                  caught instanceof ApiError && caught.status === 503
                    ? "연결하는 중이에요…"
                    : "불러오지 못했어요. 다시 시도하는 중…",
              },
        );
        timer = window.setTimeout(() => void attempt(Math.min(delayMs * 2, RETRY_MAX_MS)), delayMs);
      }
    };
    void attempt(1000);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [depsKey, tick, onAuthLost]);
  return [load, reload];
}

function Badge({ unread, mentions, look }: { unread?: number; mentions?: number; look: ListSkin["badge"] }) {
  if (!unread) return null;
  const text = unread > 99 ? "99+" : String(unread);
  const label = mentions ? `나를 부른 메시지 ${mentions}개` : `안 읽은 메시지 ${text}개`;
  if (look === "dot") {
    // Word: 숫자 대신 작은 점(나를 부르면 빨간 점)
    return <span className={mentions ? "unread-dot unread-dot-mention" : "unread-dot"} role="img" aria-label={label} title={label} />;
  }
  const shown = mentions ? `@${text}` : text;
  return (
    <span className={mentions ? "unread-badge unread-mention" : "unread-badge"} title={label}>
      {look === "paren" ? `(${shown})` : shown}
    </span>
  );
}

function PinButton({ pinned, onToggle }: { pinned: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={pinned ? "pin-button pin-on" : "pin-button"}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      aria-label={pinned ? "고정 풀기" : "고정하기"}
      title={pinned ? "고정 풀기" : "고정하기"}
    >
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
        {/* 압정 모양. 고정하면 칠해진다 */}
        <path
          d="M12.6 2.8 17.2 7.4a.8.8 0 0 1-.3 1.3l-2.3.9-2.2 2.2.2 3a.8.8 0 0 1-1.4.6L4.6 8.8a.8.8 0 0 1 .6-1.4l3 .2 2.2-2.2.9-2.3a.8.8 0 0 1 1.3-.3Z"
          fill={pinned ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
        <path d="m7.6 12.4-4.1 4.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    </button>
  );
}

function usePinToggle(
  reload: () => void,
): [string, (kind: "group" | "channel", id: string, pinned: boolean) => void] {
  const [message, setMessage] = useState("");
  const toggle = (kind: "group" | "channel", id: string, pinned: boolean) => {
    setMessage("");
    setPinned(kind, id, pinned)
      .then(reload)
      .catch((caught: unknown) => {
        if (caught instanceof ApiError && caught.code === "pin_limit") {
          setMessage(kind === "group" ? "서버는 5개까지 고정할 수 있어요." : "채널은 10개까지 고정할 수 있어요.");
        } else {
          setMessage("고정하지 못했어요.");
        }
      });
  };
  return [message, toggle];
}

function Shell({
  title,
  titleNode,
  sub,
  onBack,
  menu,
  extra,
  top,
  search,
  notice,
  onNoticeClose,
  children,
}: {
  title: string;
  /** 제목 자리에 글자 대신 넣을 것(서버 바꾸기 단추) */
  titleNode?: ReactNode;
  sub?: string;
  onBack?: () => void;
  menu: ReactNode;
  extra?: ReactNode;
  /** 목록 위 장식(메모장 경로 줄, Word 탭) */
  top?: ReactNode;
  /** 목록 찾기 칸(목록과 같이 움직이지 않게 목록 위에) */
  search?: ReactNode;
  notice?: string;
  onNoticeClose?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="room list-room">
      <header className="room-header">
        <SplitToggle />
        {onBack && (
          <button type="button" className="back-button" onClick={onBack} aria-label="뒤로">
            <BackIcon />
          </button>
        )}
        <div className="room-title">
          {titleNode ?? <strong>{title}</strong>}
          {sub && <span className="room-sub">{sub}</span>}
        </div>
        {extra}
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
      {search}
      {top}
      <div className="list-body">{children}</div>
    </div>
  );
}

/** 메모장 '열기' 창의 경로 줄과 이름 열, Word의 탭(장식) */
function ListTop({ theme, path, inGroup }: { theme: string; path: string; inGroup: boolean }) {
  if (theme === "memo") {
    return (
      <div className="skin-top skin-top-memo" aria-hidden="true">
        <div className="skin-path">{path}</div>
        <div className="skin-cols">
          <span>이름</span>
          <span>상태</span>
        </div>
      </div>
    );
  }
  if (theme === "word") {
    return (
      <div className="skin-top skin-top-word" aria-hidden="true">
        <span className="skin-tab-on">{inGroup ? "문서" : "폴더"}</span>
        <span>최근 항목</span>
      </div>
    );
  }
  return null;
}

interface CommonProps {
  menu: ReactNode;
  onAuthLost: () => void;
  notice?: string;
  onNoticeClose?: () => void;
}

function ChannelRow({
  channel,
  active,
  sub,
  skin,
  indent = 0,
  viewers,
  handle,
  hideButton,
  dim,
  onOpen,
  onPin,
}: {
  channel: ChannelInfo;
  /** 순서 바꾸기 손잡이 */
  handle?: ReactNode;
  /** 목록 편집 중: 숨기기 단추, 숨긴 것은 흐리게 */
  hideButton?: ReactNode;
  dim?: boolean;
  active?: boolean;
  sub?: string;
  skin: ListSkin;
  indent?: number;
  /** 일부만 볼 수 있는 채널이면 볼 수 있는 사람 수 */
  viewers?: number;
  onOpen: (channel: ChannelInfo) => void;
  onPin: (channel: ChannelInfo) => void;
}) {
  const classes = ["list-item"];
  if (active) classes.push("list-item-active");
  if (channel.unread) classes.push("list-item-unread");
  if (indent) classes.push("list-item-indent");
  if (dim) classes.push("list-item-dim");
  const ext = skin.channelExt(channel);
  return (
    <div
      className={classes.join(" ")}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(channel)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen(channel);
      }}
    >
      {handle}
      <span className="channel-mark">{skin.channelIcon(channel)}</span>
      <span className="list-name">
        {channel.name}
        {ext && <span className="skin-ext">{ext}</span>}
        {sub && <span className="list-sub">{sub}</span>}
      </span>
      {(channel.private || viewers !== undefined) && (
        <span
          className="list-people"
          title={viewers !== undefined ? `비공개: ${viewers}명만 볼 수 있어요` : "비공개"}
          aria-label={viewers !== undefined ? `비공개, ${viewers}명만 볼 수 있음` : "비공개"}
        >
          {channel.private && lockIcon}
          {viewers !== undefined && `${viewers}명`}
        </span>
      )}
      {!channel.can_send && channel.kind !== "forum" && skin.readOnly}
      <Badge unread={channel.unread} mentions={channel.mentions} look={skin.badge} />
      {hideButton}
      <PinButton pinned={Boolean(channel.pinned)} onToggle={() => onPin(channel)} />
    </div>
  );
}


function GroupRow({
  group,
  skin,
  expanded,
  handle,
  hideButton,
  dim,
  sub,
  onOpen,
  onPin,
}: {
  group: Group;
  skin: ListSkin;
  handle?: ReactNode;
  hideButton?: ReactNode;
  dim?: boolean;
  sub?: string;
  /** 노션 트리: 펼쳤는지(없으면 트리가 아님) */
  expanded?: boolean;
  onOpen: () => void;
  onPin: () => void;
}) {
  return (
    <div
      className={["list-item", group.unread ? "list-item-unread" : "", dim ? "list-item-dim" : ""].filter(Boolean).join(" ")}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen();
      }}
    >
      {handle}
      {expanded !== undefined && (
        <FoldChevron open={expanded} />
      )}
      <span className="channel-mark">{skin.serverIcon(group)}</span>
      <span className="list-name">
        {group.name}
        {skin.serverExt && <span className="skin-ext">{skin.serverExt}</span>}
        {sub && <span className="list-sub">{sub}</span>}
      </span>
      <Badge unread={group.unread} mentions={group.mentions} look={skin.badge} />
      {hideButton}
      <PinButton pinned={Boolean(group.pinned)} onToggle={onPin} />
    </div>
  );
}

/** 한 묶음(카테고리) 안 순서를 바꾼 뒤 서버 전체 채널 순서 */
function reorderedSections(sections: { key: string; channels: ChannelInfo[] }[], key: string, ids: string[]): string[] {
  return sections.flatMap((section) => (section.key === key ? ids : section.channels.map((channel) => channel.id)));
}

const MEMBERS_SHOWN = 30;
const MEMBERS_OPEN_KEY = "mos.members.open";

/** 서버 인원(실패하면 조용히 없음) */
function useMembers(groupId: string, onAuthLost: () => void): GroupMembers | null {
  const [load] = useLoad<GroupMembers>(() => fetchGroupMembers(groupId), [groupId], onAuthLost);
  return load.state === "ok" ? load.value : null;
}

function readMembersOpen(): boolean {
  try {
    return localStorage.getItem(MEMBERS_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

/**
 * 왼쪽 목록 아래: 서버 인원. 채널을 열고 있으면 그 채널을 볼 수 있는 사람만
 * (비공개 채널은 서버 인원과 다를 수 있다).
 */
function MemberPanel({
  data,
  channel,
  skin,
}: {
  data: GroupMembers;
  channel: { id: string; name: string } | undefined;
  skin: ListSkin;
}) {
  const [open, setOpen] = useState(readMembersOpen);
  const [all, setAll] = useState(false);
  const allowed = channel ? data.restricted[channel.id] : undefined;
  const people = allowed ? data.members.filter((member) => allowed.includes(member.id)) : data.members;
  const shown = all ? people : people.slice(0, MEMBERS_SHOWN);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(MEMBERS_OPEN_KEY, next ? "1" : "0");
    } catch {
      // 기억 못 해도 지금 화면에서는 바뀐다
    }
  };
  // 일부만 볼 수 있는 채널을 열고 있을 때만 한 줄 설명(나머지는 머리의 숫자로 충분)
  const scope = channel && allowed ? `${channel.name}: ${people.length}명만 볼 수 있어요 (전체 ${data.members.length}명)` : "";
  return (
    <section className="member-panel">
      <button type="button" className="member-toggle" aria-expanded={open} onClick={toggle}>
        <span className="member-title">{skin.membersTitle}</span>
        <span className="member-count">{people.length}</span>
        <svg className="member-chevron" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <Collapse open={open}>
        <>
          {scope && <p className="member-scope">{scope}</p>}
          <ul className="member-list">
            {shown.map((member) => (
              <li key={member.id} className="member-row" title={member.name}>
                <Avatar url={member.avatar_url} name={member.name} />
                <span className="member-name">{member.name}</span>
                {member.bot && <span className="member-bot">봇</span>}
              </li>
            ))}
          </ul>
          {people.length > shown.length && (
            <button type="button" className="text-button member-more" onClick={() => setAll(true)}>
              {people.length - shown.length}명 더 보기
            </button>
          )}
        </>
      </Collapse>
    </section>
  );
}

/** 한 서버의 채널: 카테고리 묶음, 순서, 숨기기, 찾기(채널 목록과 노션 트리가 같이 쓴다) */
function ChannelTree({
  channels,
  voice,
  orderKey,
  editing,
  query,
  skin,
  tree = false,
  activeChannelId,
  restricted,
  onOpen,
  onOpenVoice,
  onPin,
}: {
  channels: ChannelInfo[];
  voice: VoiceChannel[] | null;
  orderKey: string;
  editing: boolean;
  query: string;
  skin: ListSkin;
  /** 노션 트리 안(들여 쓰고 카테고리는 작은 글자) */
  tree?: boolean;
  activeChannelId?: string;
  restricted?: Record<string, string[]>;
  onOpen: (channel: ChannelInfo) => void;
  onOpenVoice: (voice: VoiceChannel) => void;
  onPin: (channel: ChannelInfo) => void;
}) {
  const { settings, save } = useLook();
  const { isHidden, setHidden, mode } = useHidden();
  const indent = tree ? 1 : 0;
  const sections = withVoice(channelSections(channels, settings.list_order[orderKey]), voice);
  const hideButton = (id: string, name: string) =>
    editing ? <HideButton hidden={isHidden(id)} name={name} onToggle={() => void setHidden(id, !isHidden(id))} /> : undefined;
  const channelRow = (channel: ChannelInfo, handle?: ReactNode, sub?: string) => (
    <ChannelRow
      key={channel.id}
      channel={channel}
      skin={skin}
      indent={indent}
      handle={handle}
      sub={sub}
      hideButton={hideButton(channel.id, channel.name)}
      dim={editing && isHidden(channel.id)}
      active={channel.id === activeChannelId}
      viewers={restricted?.[channel.id]?.length}
      onOpen={onOpen}
      onPin={onPin}
    />
  );
  const voiceRow = (room: VoiceChannel) => (
    <VoiceRow
      key={room.id}
      voice={room}
      skin={skin}
      indent={indent}
      extra={hideButton(room.id, room.name)}
      dim={editing && isHidden(room.id)}
      active={room.id === activeChannelId}
      onOpen={onOpenVoice}
    />
  );

  if (query) {
    // 찾기: 카테고리 없이 한 줄로(숨긴 것도 나온다, 이름 옆에 카테고리와 '숨김')
    const sub = (name: string | null, id: string) => [name, isHidden(id) ? "숨김" : ""].filter(Boolean).join(" ") || undefined;
    const found = sections.flatMap((section) => [
      ...section.channels
        .filter((channel) => nameMatches(channel.name, query))
        .map((channel) => channelRow(channel, undefined, sub(section.name, channel.id))),
      ...section.voice.filter((room) => nameMatches(room.name, query)).map(voiceRow),
    ]);
    return found.length > 0 ? (
      <section className="list-section list-found">{found}</section>
    ) : (
      <p className="list-note">‘{query}’ 이름이 들어간 채널이 없어요.</p>
    );
  }

  const hiddenChannels: { channel: ChannelInfo; category: string | null }[] = [];
  const hiddenVoice: VoiceChannel[] = [];
  const blocks = sections.map((section, _, all) => {
    const shown = editing ? section.channels : section.channels.filter((channel) => !isHidden(channel.id));
    const shownVoice = editing ? section.voice : section.voice.filter((room) => !isHidden(room.id));
    if (!editing) {
      for (const channel of section.channels) if (isHidden(channel.id)) hiddenChannels.push({ channel, category: section.name });
      hiddenVoice.push(...section.voice.filter((room) => isHidden(room.id)));
    }
    if (shown.length === 0 && shownVoice.length === 0) return null;
    // 숨긴 채널은 끌어 옮긴 묶음의 맨 뒤에 그대로 둔다(순서 기록에서 빠지지 않게)
    const reorder = (ids: string[]) =>
      void save({
        list_order: {
          [orderKey]: reorderedSections(all, section.key, [
            ...ids,
            ...section.channels.filter((channel) => !ids.includes(channel.id)).map((channel) => channel.id),
          ]),
        },
      });
    const body = (
      <>
        <Sortable items={shown} editing={editing} label={(channel) => channel.name} onReorder={reorder}>
          {(channel, handle) => channelRow(channel, handle)}
        </Sortable>
        {shownVoice.map(voiceRow)}
      </>
    );
    return tree ? (
      <div key={section.key || "-"} role="group" aria-label={section.name ?? undefined}>
        {section.name && <p className="tree-category">{section.name}</p>}
        {body}
      </div>
    ) : (
      <section key={section.key || "-"} className="list-section">
        {section.name && <h2 className="list-section-title">{section.name}</h2>}
        {body}
      </section>
    );
  });
  let foldedUnread = 0;
  let foldedMentions = 0;
  for (const { channel } of hiddenChannels) {
    const [unread, mentions] = hiddenCounts(channel.unread ?? 0, channel.mentions ?? 0, mode);
    foldedUnread += unread;
    foldedMentions += mentions;
  }
  return (
    <>
      {blocks}
      <HiddenFolder
        tree={tree}
        count={hiddenChannels.length + hiddenVoice.length}
        badge={<Badge unread={foldedUnread} mentions={foldedMentions} look={skin.badge} />}
      >
        {hiddenChannels.map(({ channel, category }) => channelRow(channel, undefined, category ?? undefined))}
        {hiddenVoice.map(voiceRow)}
      </HiddenFolder>
    </>
  );
}

/** 노션 트리: 펼친 서버 아래 채널(하위 페이지) */
function TreeChannels({
  groupId,
  activeChannelId,
  skin,
  editing,
  onOpen,
  onOpenVoice,
  onAuthLost,
}: {
  groupId: string;
  activeChannelId?: string;
  skin: ListSkin;
  /** 순서 바꾸기 중 */
  editing: boolean;
  onOpen: (channel: ChannelInfo) => void;
  onOpenVoice: (voice: VoiceChannel) => void;
  onAuthLost: () => void;
}) {
  const [load, reload] = useLoad<GroupChannels>(() => fetchGroupChannels(groupId), [groupId], onAuthLost);
  const members = useMembers(groupId, onAuthLost);
  const { settings } = useLook();
  const voice = useVoiceChannels(groupId, settings.voice_view);
  const orderKey = `c:${groupId}`;
  const [pinError, togglePin] = usePinToggle(reload);
  if (load.state !== "ok") return <p className="list-note tree-note">{load.state === "loading" ? "불러오는 중…" : load.message}</p>;
  if (load.value.channels.length === 0 && !voice?.length) {
    return <p className="list-note tree-note">볼 수 있는 페이지가 없어요.</p>;
  }
  return (
    <>
      {pinError && <p className="list-error">{pinError}</p>}
      <ChannelTree
        channels={load.value.channels}
        voice={voice}
        orderKey={orderKey}
        editing={editing}
        query=""
        skin={skin}
        tree
        activeChannelId={activeChannelId}
        restricted={members?.restricted}
        onOpen={onOpen}
        onOpenVoice={onOpenVoice}
        onPin={(item) => togglePin("channel", item.id, !item.pinned)}
      />
      {editing && (
        <div className="order-bar order-bar-tree">
          <ResetOrder keys={[orderKey]} what="이 서버 페이지" />
        </div>
      )}
    </>
  );
}

/** 노션: 지금 서버의 인원은 트리 맨 아래에 따로(다른 서버 사이에 끼지 않게) */
function TreeMembers({
  groupId,
  activeChannelId,
  skin,
  onAuthLost,
}: {
  groupId: string;
  activeChannelId?: string;
  skin: ListSkin;
  onAuthLost: () => void;
}) {
  const members = useMembers(groupId, onAuthLost);
  const [load] = useLoad<GroupChannels>(() => fetchGroupChannels(groupId), [groupId], onAuthLost);
  if (!members) return null;
  const channels = load.state === "ok" ? load.value.channels : [];
  return (
    <MemberPanel data={members} channel={channels.find((channel) => channel.id === activeChannelId)} skin={skin} />
  );
}

const NO_GROUPS: Group[] = [];

/** 서버 목록에서 찾은 것: 서버, 채널(어느 서버인지와 숨김 여부를 이름 옆에) */
function FoundAcross({
  query,
  groups,
  channels,
  voice,
  loading,
  skin,
  isHidden,
  onOpen,
  onOpenChannel,
  onOpenVoice,
  onPinGroup,
  onPinChannel,
}: {
  query: string;
  groups: Group[];
  channels: ChannelInfo[];
  voice: VoiceChannel[];
  loading: boolean;
  skin: ListSkin;
  isHidden: (id: string) => boolean;
  onOpen: (groupId: string) => void;
  onOpenChannel: (groupId: string, channel: ChannelInfo) => void;
  onOpenVoice: (groupId: string, voice: VoiceChannel) => void;
  onPinGroup: (group: Group) => void;
  onPinChannel: (channel: ChannelInfo) => void;
}) {
  const hiddenMark = (id: string, place?: string) =>
    [place, isHidden(id) ? "숨김" : ""].filter(Boolean).join(" ") || undefined;
  const foundGroups = groups.filter((group) => nameMatches(group.name, query));
  const foundChannels = channels.filter((channel) => nameMatches(channel.name, query));
  const foundVoice = voice.filter((room) => nameMatches(room.name, query));
  return (
    <>
      {foundGroups.length > 0 && (
        <section className="list-section list-found">
          <h2 className="list-section-title">서버</h2>
          {foundGroups.map((group) => (
            <GroupRow
              key={group.id}
              group={group}
              skin={skin}
              sub={hiddenMark(group.id)}
              onOpen={() => onOpen(group.id)}
              onPin={() => onPinGroup(group)}
            />
          ))}
        </section>
      )}
      {foundChannels.length + foundVoice.length > 0 && (
        <section className="list-section list-found">
          <h2 className="list-section-title">채널</h2>
          {foundChannels.map((channel) => (
            <ChannelRow
              key={channel.id}
              channel={channel}
              skin={skin}
              sub={hiddenMark(channel.id, channel.group_name)}
              onOpen={(item) => onOpenChannel(item.group_id, item)}
              onPin={onPinChannel}
            />
          ))}
          {foundVoice.map((room) => (
            <VoiceRow
              key={room.id}
              voice={room}
              skin={skin}
              sub={hiddenMark(room.id, room.group_name)}
              onOpen={(item) => onOpenVoice(item.group_id, item)}
            />
          ))}
        </section>
      )}
      {loading && <p className="list-note">채널을 찾는 중…</p>}
      {!loading && foundGroups.length + foundChannels.length + foundVoice.length === 0 && (
        <p className="list-note">‘{query}’ 이름이 들어간 서버나 채널이 없어요.</p>
      )}
    </>
  );
}

/** 서버 목록에서 찾을 때: 모든 서버의 채널을 한 번씩만 받아 둔다(찾기 칸을 쓸 때만) */
function useAllChannels(
  groups: Group[],
  enabled: boolean,
  withVoiceRooms: boolean,
): { channels: ChannelInfo[]; voice: VoiceChannel[]; loading: boolean } {
  const [byGroup, setByGroup] = useState<Record<string, { channels: ChannelInfo[]; voice: VoiceChannel[] }>>({});
  const asked = useRef(new Set<string>());
  const [pending, setPending] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    for (const group of groups) {
      if (asked.current.has(group.id)) continue;
      asked.current.add(group.id);
      setPending((count) => count + 1);
      Promise.all([
        fetchGroupChannels(group.id),
        // 음성 채널은 못 받아도 글 채널은 찾게
        withVoiceRooms ? fetchGroupVoice(group.id).catch(() => ({ channels: [] })) : { channels: [] },
      ])
        .then(([text, voice]) =>
          setByGroup((current) => ({ ...current, [group.id]: { channels: text.channels, voice: voice.channels } })),
        )
        .catch(() => asked.current.delete(group.id)) // 다음에 찾을 때 다시
        .finally(() => setPending((count) => count - 1));
    }
  }, [groups, enabled, withVoiceRooms]);
  const names = new Map(groups.map((group) => [group.id, group.name]));
  const channels = groups.flatMap((group) =>
    (byGroup[group.id]?.channels ?? []).map((channel) => ({
      ...channel,
      group_name: channel.group_name || names.get(group.id) || "",
    })),
  );
  const voice = withVoiceRooms
    ? groups.flatMap((group) =>
        (byGroup[group.id]?.voice ?? []).map((room) => ({ ...room, group_name: names.get(group.id) || room.group_name })),
      )
    : [];
  return { channels, voice, loading: pending > 0 };
}

export function GroupList({
  onOpen,
  onOpenChannel,
  onOpenVoice,
  tree = false,
  openGroupId,
  activeChannelId,
  ...common
}: CommonProps & {
  onOpen: (groupId: string) => void;
  onOpenChannel: (groupId: string, channel: ChannelInfo) => void;
  onOpenVoice: (groupId: string, voice: VoiceChannel) => void;
  /** 노션: 서버를 누르면 그 자리에서 채널이 펼쳐지는 트리 */
  tree?: boolean;
  openGroupId?: string;
  activeChannelId?: string;
}) {
  const { settings, save } = useLook();
  const { theme } = settings;
  const skin = listSkin(theme);
  const [editing, setEditing] = useState(false);
  const [load, reload] = useLoad<GroupListData>(fetchGroups, [], common.onAuthLost);
  const [pinError, togglePin] = usePinToggle(reload);
  const { isHidden, setHidden, mode } = useHidden();
  const [query, setQuery] = useState("");
  const startEditing = (value: boolean) => {
    setQuery("");
    setEditing(value);
  };
  const allGroups = load.state === "ok" ? load.value.groups : NO_GROUPS;
  const everyChannel = useAllChannels(allGroups, query.length > 0, settings.voice_view);
  // 숨기면 서버 합계(숨김 알림 설정대로)가 바뀌어 다시 받는다
  const hide = (id: string, value: boolean) => void setHidden(id, value).then(reload);
  const hideButton = (id: string, name: string) =>
    editing ? <HideButton hidden={isHidden(id)} name={name} onToggle={() => hide(id, !isHidden(id))} /> : undefined;
  const [expanded, setExpanded] = useState<string[]>(openGroupId ? [openGroupId] : []);
  useEffect(() => {
    if (openGroupId) setExpanded((current) => (current.includes(openGroupId) ? current : [...current, openGroupId]));
  }, [openGroupId]);
  const toggle = (groupId: string) =>
    setExpanded((current) => (current.includes(groupId) ? current.filter((id) => id !== groupId) : [...current, groupId]));
  const ordered = load.state === "ok" ? applyOrder(load.value.groups, settings.list_order.groups) : [];
  const pinnedOrdered = load.state === "ok" ? applyOrder(load.value.pinned_channels, settings.list_order.pinned) : [];
  // 목록 편집 중이 아니면 숨긴 것은 빼서 맨 아래 묶음으로
  const shownGroups = editing ? ordered : ordered.filter((group) => !isHidden(group.id));
  const shownPinned = editing ? pinnedOrdered : pinnedOrdered.filter((channel) => !isHidden(channel.id));
  const hiddenGroups = editing ? [] : ordered.filter((group) => isHidden(group.id) && group.id !== openGroupId);
  const hiddenPinned = editing ? [] : pinnedOrdered.filter((channel) => isHidden(channel.id));
  const keepHidden = (ids: string[], all: { id: string }[]) => [
    ...ids,
    ...all.filter((item) => !ids.includes(item.id)).map((item) => item.id),
  ];
  // 노션에서 서버를 연 때(순서 바꾸기 중이 아니면): 지금 서버와 다른 서버 묶음으로 나눈다
  const current = tree && openGroupId && !editing && !query ? ordered.find((group) => group.id === openGroupId) : undefined;
  const others = current ? shownGroups.filter((group) => group.id !== current.id) : [];
  const [othersOpen, setOthersOpen] = useState(false);
  useEffect(() => setOthersOpen(false), [openGroupId]);
  const toggleOthers = () => setOthersOpen((value) => !value);
  const treeGroup = (group: Group, handle: ReactNode) => {
    const open = tree && expanded.includes(group.id);
    return (
      <>
        <GroupRow
          group={group}
          skin={skin}
          handle={handle}
          hideButton={hideButton(group.id, group.name)}
          dim={editing && isHidden(group.id)}
          expanded={tree ? open : undefined}
          onOpen={() => (tree ? toggle(group.id) : onOpen(group.id))}
          onPin={() => togglePin("group", group.id, !group.pinned)}
        />
        {tree && (
          <Collapse open={open}>
            <TreeChannels
              groupId={group.id}
              activeChannelId={activeChannelId}
              skin={skin}
              editing={editing}
              onOpen={(channel) => onOpenChannel(group.id, channel)}
              onOpenVoice={(voice) => onOpenVoice(group.id, voice)}
              onAuthLost={common.onAuthLost}
            />
          </Collapse>
        )}
      </>
    );
  };
  return (
    <Shell
      title={skin.groupsTitle}
      menu={common.menu}
      top={<ListTop theme={theme} path={"C:\\문서"} inGroup={false} />}
      search={<ListSearch value={query} placeholder={skin.search(false)} onChange={setQuery} />}
      notice={common.notice}
      onNoticeClose={common.onNoticeClose}
    >
      {pinError && <p className="list-error">{pinError}</p>}
      {load.state === "loading" && <p className="list-note">불러오는 중…</p>}
      {load.state === "error" && <p className="list-note">{load.message}</p>}
      {load.state === "ok" && query && (
        <FoundAcross
          query={query}
          groups={ordered}
          channels={everyChannel.channels}
          voice={everyChannel.voice}
          loading={everyChannel.loading}
          skin={skin}
          isHidden={isHidden}
          onOpen={onOpen}
          onOpenChannel={onOpenChannel}
          onOpenVoice={onOpenVoice}
          onPinGroup={(group) => togglePin("group", group.id, !group.pinned)}
          onPinChannel={(channel) => togglePin("channel", channel.id, !channel.pinned)}
        />
      )}
      {load.state === "ok" && !query && shownPinned.length > 0 && (
        <section className="list-section">
          <h2 className="list-section-title">{skin.pinnedTitle}</h2>
          <Sortable
            items={shownPinned}
            editing={editing}
            label={(channel) => channel.name}
            onReorder={(ids) => void save({ list_order: { pinned: keepHidden(ids, pinnedOrdered) } })}
          >
            {(channel, handle) => (
              <ChannelRow
                channel={{ ...channel, pinned: true }}
                skin={skin}
                sub={channel.group_name}
                handle={handle}
                hideButton={hideButton(channel.id, channel.name)}
                dim={editing && isHidden(channel.id)}
                onOpen={(item) => onOpenChannel(item.group_id, item)}
                onPin={(item) => togglePin("channel", item.id, false)}
              />
            )}
          </Sortable>
        </section>
      )}
      {load.state === "ok" && load.value.groups.length === 0 && (
        <p className="list-note">이 계정으로 볼 수 있는 서버가 없어요.</p>
      )}
      {load.state === "ok" && current && (
        // 노션에서 서버를 연 때: 맨 위 '다른 서버' 묶음은 접어 두고, 그 아래 지금 서버만 펼친다(다른 테마도 서버 바꾸기가 위)
        <section className="list-section">
          {skin.allTitle && <h2 className="list-section-title">{skin.allTitle}</h2>}
          {others.length > 0 && (
            <>
              <div
                className="list-item tree-others"
                role="button"
                tabIndex={0}
                aria-expanded={othersOpen}
                onClick={() => toggleOthers()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") toggleOthers();
                }}
              >
                <FoldChevron open={othersOpen} />
                <span className="list-name">
                  다른 서버<span className="tree-others-count">{others.length}</span>
                </span>
                {!othersOpen && (
                  <Badge
                    unread={others.reduce((sum, group) => sum + (group.unread ?? 0), 0)}
                    mentions={others.reduce((sum, group) => sum + (group.mentions ?? 0), 0)}
                    look={skin.badge}
                  />
                )}
              </div>
              <Collapse open={othersOpen}>
                <div className="tree-others-list">
                  {others.map((group) => (
                    <GroupRow
                      key={group.id}
                      group={group}
                      skin={skin}
                      onOpen={() => onOpen(group.id)}
                      onPin={() => togglePin("group", group.id, !group.pinned)}
                    />
                  ))}
                </div>
              </Collapse>
            </>
          )}
          {treeGroup(current, null)}
        </section>
      )}
      {load.state === "ok" && !query && !current && shownGroups.length > 0 && (
        <section className="list-section">
          {skin.allTitle && <h2 className="list-section-title">{skin.allTitle}</h2>}
          <Sortable
            items={shownGroups}
            editing={editing}
            label={(group) => group.name}
            onReorder={(ids) => void save({ list_order: { groups: keepHidden(ids, ordered) } })}
          >
            {(group, handle) => treeGroup(group, handle)}
          </Sortable>
        </section>
      )}
      {load.state === "ok" && !query && (
        <HiddenFolder
          count={hiddenGroups.length + hiddenPinned.length}
          badge={(() => {
            // 숨긴 서버의 합계는 서버가 이미 숨김 알림 설정대로 세어 보낸다
            let unread = 0;
            let mentions = 0;
            for (const group of hiddenGroups) {
              unread += group.unread ?? 0;
              mentions += group.mentions ?? 0;
            }
            for (const channel of hiddenPinned) {
              const [u, m] = hiddenCounts(channel.unread ?? 0, channel.mentions ?? 0, mode);
              unread += u;
              mentions += m;
            }
            return <Badge unread={unread} mentions={mentions} look={skin.badge} />;
          })()}
        >
          {hiddenPinned.map((channel) => (
            <ChannelRow
              key={channel.id}
              channel={{ ...channel, pinned: true }}
              skin={skin}
              sub={channel.group_name}
              onOpen={(item) => onOpenChannel(item.group_id, item)}
              onPin={(item) => togglePin("channel", item.id, false)}
            />
          ))}
          {hiddenGroups.map((group) => (
            <GroupRow
              key={group.id}
              group={group}
              skin={skin}
              onOpen={() => onOpen(group.id)}
              onPin={() => togglePin("group", group.id, !group.pinned)}
            />
          ))}
        </HiddenFolder>
      )}
      {load.state === "ok" && !query && load.value.groups.length + load.value.pinned_channels.length > 1 && (
        <OrderBar editing={editing} onEditing={startEditing} keys={["groups", "pinned"]} what="서버" />
      )}
      {tree && openGroupId && (
        <TreeMembers
          groupId={openGroupId}
          activeChannelId={activeChannelId}
          skin={skin}
          onAuthLost={common.onAuthLost}
        />
      )}
    </Shell>
  );
}

/** 채널 목록 머리: 서버 이름을 누르면 다른 서버를 바로 고를 수 있다 */
function ServerSwitch({
  title,
  groupId,
  onSwitch,
  onAll,
}: {
  title: string;
  groupId: string;
  onSwitch: (groupId: string) => void;
  onAll: () => void;
}) {
  const { theme, list_order: listOrder } = useLook().settings;
  const skin = listSkin(theme);
  const [open, setOpen] = useState(false);
  const presence = usePresence(open, 150);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [failed, setFailed] = useState(false);
  const boxRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    setFailed(false);
    fetchGroups()
      .then((value) => {
        if (!stopped) setGroups(value.groups);
      })
      .catch(() => {
        if (!stopped) setFailed(true);
      });
    const onDown = (event: PointerEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      stopped = true;
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (id: string) => {
    setOpen(false);
    if (id !== groupId) onSwitch(id);
  };
  return (
    <span className="server-switch" ref={boxRef}>
      <button
        type="button"
        className="server-switch-button"
        aria-haspopup="menu"
        aria-expanded={open}
        title="다른 서버로"
        onClick={() => setOpen(!open)}
      >
        <strong>{title}</strong>
        <svg className="server-switch-chevron" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {presence.shown && (
        <div className={presence.closing ? "server-switch-menu pop-out" : "server-switch-menu"} role="menu" inert={presence.closing}>
          {!groups && !failed && <p className="server-switch-note">불러오는 중…</p>}
          {failed && <p className="server-switch-note">불러오지 못했어요.</p>}
          {groups && applyOrder(groups, listOrder.groups).map((group) => (
            <button
              key={group.id}
              type="button"
              role="menuitemradio"
              aria-checked={group.id === groupId}
              className="server-switch-item"
              onClick={() => pick(group.id)}
            >
              <span className="channel-mark">{skin.serverIcon(group)}</span>
              <span className="server-switch-name">{group.name}</span>
              {group.unread ? <span className="server-switch-dot" aria-label="안 읽은 글 있음" /> : null}
              {group.id === groupId && (
                <span className="server-switch-check" aria-hidden="true">
                  ✓
                </span>
              )}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className="server-switch-item server-switch-all"
            onClick={() => {
              setOpen(false);
              onAll();
            }}
          >
            전체 서버 목록
          </button>
        </div>
      )}
    </span>
  );
}

export function ChannelList({
  groupId,
  activeChannelId,
  onOpen,
  onOpenVoice,
  onBack,
  onSwitch,
  ...common
}: CommonProps & {
  groupId: string;
  activeChannelId?: string;
  onOpen: (channel: ChannelInfo) => void;
  onOpenVoice: (voice: VoiceChannel) => void;
  onBack: () => void;
  /** 머리의 서버 이름에서 다른 서버를 골랐을 때 */
  onSwitch: (groupId: string) => void;
}) {
  const { settings } = useLook();
  const { theme } = settings;
  const skin = listSkin(theme);
  const [editing, setEditing] = useState(false);
  const orderKey = `c:${groupId}`;
  const [load, reload] = useLoad<GroupChannels>(
    () => fetchGroupChannels(groupId),
    [groupId, activeChannelId],
    common.onAuthLost,
  );
  const [pinError, togglePin] = usePinToggle(reload);
  const members = useMembers(groupId, common.onAuthLost);
  const voice = useVoiceChannels(groupId, settings.voice_view);
  const group = load.state === "ok" ? load.value.group : null;
  const [query, setQuery] = useState("");
  const startEditing = (value: boolean) => {
    setQuery("");
    setEditing(value);
  };
  return (
    <Shell
      search={<ListSearch value={query} placeholder={skin.search(true)} onChange={setQuery} />}
      title={group ? skin.channelsTitle(group.name) : "…"}
      titleNode={
        group ? (
          <ServerSwitch title={skin.channelsTitle(group.name)} groupId={groupId} onSwitch={onSwitch} onAll={onBack} />
        ) : undefined
      }
      onBack={onBack}
      menu={common.menu}
      top={<ListTop theme={theme} path={`C:\\문서\\${group?.name ?? ""}`} inGroup />}
      extra={
        group && (
          <PinButton pinned={Boolean(group.pinned)} onToggle={() => togglePin("group", group.id, !group.pinned)} />
        )
      }
      notice={common.notice}
      onNoticeClose={common.onNoticeClose}
    >
      {pinError && <p className="list-error">{pinError}</p>}
      {theme === "memo" && (
        // 파일 열기 창의 '..'(위 폴더로)
        <div
          className="list-item skin-up"
          role="button"
          tabIndex={0}
          aria-label="서버 목록으로"
          onClick={onBack}
          onKeyDown={(event) => {
            if (event.key === "Enter") onBack();
          }}
        >
          <span className="channel-mark">{skin.serverIcon({ id: groupId, name: "", icon_url: null })}</span>
          <span className="list-name">..</span>
        </div>
      )}
      {load.state === "loading" && <p className="list-note">불러오는 중…</p>}
      {load.state === "error" && <p className="list-note">{load.message}</p>}
      {load.state === "ok" && load.value.channels.length === 0 && !voice?.length && (
        <p className="list-note">이 계정으로 볼 수 있는 채널이 없어요.</p>
      )}
      {load.state === "ok" && (
        <ChannelTree
          channels={load.value.channels}
          voice={voice}
          orderKey={orderKey}
          editing={editing}
          query={query}
          skin={skin}
          activeChannelId={activeChannelId}
          restricted={members?.restricted}
          onOpen={onOpen}
          onOpenVoice={onOpenVoice}
          onPin={(item) => togglePin("channel", item.id, !item.pinned)}
        />
      )}
      {load.state === "ok" && !query && load.value.channels.length + (voice?.length ?? 0) > 1 && (
        <OrderBar editing={editing} onEditing={startEditing} keys={[orderKey]} what="채널" />
      )}
      {load.state === "ok" && members && (
        <MemberPanel
          data={members}
          channel={load.value.channels.find((channel) => channel.id === activeChannelId)}
          skin={skin}
        />
      )}
    </Shell>
  );
}

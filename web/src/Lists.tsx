import SplitToggle from "./SplitToggle";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, fetchGroupChannels, fetchGroupMembers, fetchGroups, setPinned } from "./api";
import { type ListSkin, listSkin } from "./listSkin";
import { useLook } from "./lookContext";
import { Avatar } from "./MessageItem";
import type { ChannelInfo, Group, GroupChannels, GroupList as GroupListData, GroupMembers } from "./types";

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
  sub,
  onBack,
  menu,
  extra,
  top,
  notice,
  onNoticeClose,
  children,
}: {
  title: string;
  sub?: string;
  onBack?: () => void;
  menu: ReactNode;
  extra?: ReactNode;
  /** 목록 위 장식(메모장 경로 줄, Word 탭) */
  top?: ReactNode;
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
            ‹
          </button>
        )}
        <div className="room-title">
          <strong>{title}</strong>
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
  onOpen,
  onPin,
}: {
  channel: ChannelInfo;
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
      <span className="channel-mark">{skin.channelIcon(channel)}</span>
      <span className="list-name">
        {channel.name}
        {ext && <span className="skin-ext">{ext}</span>}
        {sub && <span className="list-sub">{sub}</span>}
      </span>
      {viewers !== undefined && (
        <span className="list-people" title={`${viewers}명만 볼 수 있어요`} aria-label={`${viewers}명만 볼 수 있음`}>
          {viewers}명
        </span>
      )}
      {!channel.can_send && channel.kind !== "forum" && skin.readOnly}
      <Badge unread={channel.unread} mentions={channel.mentions} look={skin.badge} />
      <PinButton pinned={Boolean(channel.pinned)} onToggle={() => onPin(channel)} />
    </div>
  );
}

function groupByCategory(
  channels: ChannelInfo[],
): { key: string; name: string | null; channels: ChannelInfo[] }[] {
  const sections: { key: string; name: string | null; channels: ChannelInfo[] }[] = [];
  for (const channel of channels) {
    const key = channel.category_id ?? "";
    let section = sections.find((item) => item.key === key);
    if (!section) {
      section = { key, name: channel.category_name, channels: [] };
      sections.push(section);
    }
    section.channels.push(channel);
  }
  return sections;
}

function GroupRow({
  group,
  skin,
  expanded,
  onOpen,
  onPin,
}: {
  group: Group;
  skin: ListSkin;
  /** 노션 트리: 펼쳤는지(없으면 트리가 아님) */
  expanded?: boolean;
  onOpen: () => void;
  onPin: () => void;
}) {
  return (
    <div
      className={group.unread ? "list-item list-item-unread" : "list-item"}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen();
      }}
    >
      {expanded !== undefined && (
        <span className="tree-chevron" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
      )}
      <span className="channel-mark">{skin.serverIcon(group)}</span>
      <span className="list-name">
        {group.name}
        {skin.serverExt && <span className="skin-ext">{skin.serverExt}</span>}
      </span>
      <Badge unread={group.unread} mentions={group.mentions} look={skin.badge} />
      <PinButton pinned={Boolean(group.pinned)} onToggle={onPin} />
    </div>
  );
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
  channel: ChannelInfo | undefined;
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
  const scope = !channel
    ? `서버 전체 ${people.length}명`
    : allowed
      ? `${channel.name}: ${people.length}명만 볼 수 있어요 (전체 ${data.members.length}명)`
      : `${channel.name}: 모두 볼 수 있어요`;
  return (
    <section className="list-section member-panel">
      <button type="button" className="list-section-title member-toggle" aria-expanded={open} onClick={toggle}>
        <span>{skin.membersTitle}</span>
        <span className="member-count">{people.length}</span>
        <span className="member-chevron" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <>
          <p className="member-scope">{scope}</p>
          <ul className="member-list">
            {shown.map((member) => (
              <li key={member.id} className="member-row" title={member.name}>
                <Avatar url={member.avatar_url} name={member.name} />
                <span className="member-name">{member.name}</span>
                {member.bot && <span className="skin-ro">봇</span>}
              </li>
            ))}
          </ul>
          {people.length > shown.length && (
            <button type="button" className="text-button member-more" onClick={() => setAll(true)}>
              {people.length - shown.length}명 더 보기
            </button>
          )}
        </>
      )}
    </section>
  );
}

/** 노션 트리: 펼친 서버 아래 채널(하위 페이지) */
function TreeChannels({
  groupId,
  activeChannelId,
  skin,
  onOpen,
  onAuthLost,
}: {
  groupId: string;
  activeChannelId?: string;
  skin: ListSkin;
  onOpen: (channel: ChannelInfo) => void;
  onAuthLost: () => void;
}) {
  const [load, reload] = useLoad<GroupChannels>(() => fetchGroupChannels(groupId), [groupId], onAuthLost);
  const members = useMembers(groupId, onAuthLost);
  const [pinError, togglePin] = usePinToggle(reload);
  if (load.state !== "ok") return <p className="list-note tree-note">{load.state === "loading" ? "불러오는 중…" : load.message}</p>;
  if (load.value.channels.length === 0) return <p className="list-note tree-note">볼 수 있는 페이지가 없어요.</p>;
  return (
    <>
      {pinError && <p className="list-error">{pinError}</p>}
      {groupByCategory(load.value.channels).map((section) => (
        <div key={section.key || "-"} role="group" aria-label={section.name ?? undefined}>
          {section.name && <p className="tree-category">{section.name}</p>}
          {section.channels.map((channel) => (
            <ChannelRow
              key={channel.id}
              channel={channel}
              skin={skin}
              indent={1}
              active={channel.id === activeChannelId}
              viewers={members?.restricted[channel.id]?.length}
              onOpen={onOpen}
              onPin={(item) => togglePin("channel", item.id, !item.pinned)}
            />
          ))}
        </div>
      ))}
      {members && (
        <MemberPanel
          data={members}
          channel={load.value.channels.find((channel) => channel.id === activeChannelId)}
          skin={skin}
        />
      )}
    </>
  );
}

export function GroupList({
  onOpen,
  onOpenChannel,
  tree = false,
  openGroupId,
  activeChannelId,
  ...common
}: CommonProps & {
  onOpen: (groupId: string) => void;
  onOpenChannel: (groupId: string, channel: ChannelInfo) => void;
  /** 노션: 서버를 누르면 그 자리에서 채널이 펼쳐지는 트리 */
  tree?: boolean;
  openGroupId?: string;
  activeChannelId?: string;
}) {
  const { theme } = useLook().settings;
  const skin = listSkin(theme);
  const [load, reload] = useLoad<GroupListData>(fetchGroups, [], common.onAuthLost);
  const [pinError, togglePin] = usePinToggle(reload);
  const [expanded, setExpanded] = useState<string[]>(openGroupId ? [openGroupId] : []);
  useEffect(() => {
    if (openGroupId) setExpanded((current) => (current.includes(openGroupId) ? current : [...current, openGroupId]));
  }, [openGroupId]);
  const toggle = (groupId: string) =>
    setExpanded((current) => (current.includes(groupId) ? current.filter((id) => id !== groupId) : [...current, groupId]));
  return (
    <Shell
      title={skin.groupsTitle}
      menu={common.menu}
      top={<ListTop theme={theme} path={"C:\\문서"} inGroup={false} />}
      notice={common.notice}
      onNoticeClose={common.onNoticeClose}
    >
      {pinError && <p className="list-error">{pinError}</p>}
      {load.state === "loading" && <p className="list-note">불러오는 중…</p>}
      {load.state === "error" && <p className="list-note">{load.message}</p>}
      {load.state === "ok" && load.value.pinned_channels.length > 0 && (
        <section className="list-section">
          <h2 className="list-section-title">{skin.pinnedTitle}</h2>
          {load.value.pinned_channels.map((channel) => (
            <ChannelRow
              key={channel.id}
              channel={{ ...channel, pinned: true }}
              skin={skin}
              sub={channel.group_name}
              onOpen={(item) => onOpenChannel(item.group_id, item)}
              onPin={(item) => togglePin("channel", item.id, false)}
            />
          ))}
        </section>
      )}
      {load.state === "ok" && load.value.groups.length === 0 && (
        <p className="list-note">이 계정으로 볼 수 있는 서버가 없어요.</p>
      )}
      {load.state === "ok" && load.value.groups.length > 0 && (
        <section className="list-section">
          {skin.allTitle && <h2 className="list-section-title">{skin.allTitle}</h2>}
          {load.value.groups.map((group) => {
            const open = tree && expanded.includes(group.id);
            return (
              <div key={group.id}>
                <GroupRow
                  group={group}
                  skin={skin}
                  expanded={tree ? open : undefined}
                  onOpen={() => (tree ? toggle(group.id) : onOpen(group.id))}
                  onPin={() => togglePin("group", group.id, !group.pinned)}
                />
                {open && (
                  <TreeChannels
                    groupId={group.id}
                    activeChannelId={activeChannelId}
                    skin={skin}
                    onOpen={(channel) => onOpenChannel(group.id, channel)}
                    onAuthLost={common.onAuthLost}
                  />
                )}
              </div>
            );
          })}
        </section>
      )}
    </Shell>
  );
}

export function ChannelList({
  groupId,
  activeChannelId,
  onOpen,
  onBack,
  ...common
}: CommonProps & {
  groupId: string;
  activeChannelId?: string;
  onOpen: (channel: ChannelInfo) => void;
  onBack: () => void;
}) {
  const { theme } = useLook().settings;
  const skin = listSkin(theme);
  const [load, reload] = useLoad<GroupChannels>(
    () => fetchGroupChannels(groupId),
    [groupId, activeChannelId],
    common.onAuthLost,
  );
  const [pinError, togglePin] = usePinToggle(reload);
  const members = useMembers(groupId, common.onAuthLost);
  const group = load.state === "ok" ? load.value.group : null;
  return (
    <Shell
      title={group ? skin.channelsTitle(group.name) : "…"}
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
      {load.state === "ok" && load.value.channels.length === 0 && (
        <p className="list-note">이 계정으로 볼 수 있는 채널이 없어요.</p>
      )}
      {load.state === "ok" &&
        groupByCategory(load.value.channels).map((section) => (
          <section key={section.key || "-"} className="list-section">
            {section.name && <h2 className="list-section-title">{section.name}</h2>}
            {section.channels.map((channel) => (
              <ChannelRow
                key={channel.id}
                channel={channel}
                skin={skin}
                active={channel.id === activeChannelId}
                viewers={members?.restricted[channel.id]?.length}
                onOpen={onOpen}
                onPin={(item) => togglePin("channel", item.id, !item.pinned)}
              />
            ))}
          </section>
        ))}
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

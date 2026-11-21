import SplitToggle from "./SplitToggle";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, fetchGroupChannels, fetchGroups, setPinned } from "./api";
import { isDiscordMediaUrl } from "./format";
import type { ChannelInfo, Group, GroupChannels, GroupList as GroupListData } from "./types";

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
          setLoad({ state: "error", message: "볼 수 없는 모임이에요. 목록으로 돌아가 주세요." });
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

function GroupIcon({ group }: { group: Group }) {
  if (isDiscordMediaUrl(group.icon_url)) {
    return <img className="group-icon" src={group.icon_url} alt="" loading="lazy" referrerPolicy="no-referrer" />;
  }
  return <div className="group-icon group-icon-fallback">{group.name.slice(0, 1)}</div>;
}

function Badge({ unread, mentions }: { unread?: number; mentions?: number }) {
  if (!unread) return null;
  const text = unread > 99 ? "99+" : String(unread);
  return (
    <span
      className={mentions ? "unread-badge unread-mention" : "unread-badge"}
      title={mentions ? `나를 부른 메시지 ${mentions}개` : undefined}
    >
      {mentions ? `@ ${text}` : text}
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
          setMessage(kind === "group" ? "모임은 5개까지 고정할 수 있어요." : "채널은 10개까지 고정할 수 있어요.");
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
  notice,
  onNoticeClose,
  children,
}: {
  title: string;
  sub?: string;
  onBack?: () => void;
  menu: ReactNode;
  extra?: ReactNode;
  notice?: string;
  onNoticeClose?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="room">
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
      <div className="list-body">{children}</div>
    </div>
  );
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
  onOpen,
  onPin,
}: {
  channel: ChannelInfo;
  active?: boolean;
  sub?: string;
  onOpen: (channel: ChannelInfo) => void;
  onPin: (channel: ChannelInfo) => void;
}) {
  const classes = ["list-item"];
  if (active) classes.push("list-item-active");
  if (channel.unread) classes.push("list-item-unread");
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
      <span className="channel-mark">{channel.kind === "forum" ? "▤" : channel.kind === "news" ? "📢" : "#"}</span>
      <span className="list-name">
        {channel.name}
        {sub && <span className="list-sub">{sub}</span>}
      </span>
      {!channel.can_send && channel.kind !== "forum" && <span className="list-badge">읽기만</span>}
      <Badge unread={channel.unread} mentions={channel.mentions} />
      <PinButton pinned={Boolean(channel.pinned)} onToggle={() => onPin(channel)} />
    </div>
  );
}

export function GroupList({
  onOpen,
  onOpenChannel,
  ...common
}: CommonProps & {
  onOpen: (groupId: string) => void;
  onOpenChannel: (groupId: string, channel: ChannelInfo) => void;
}) {
  const [load, reload] = useLoad<GroupListData>(fetchGroups, [], common.onAuthLost);
  const [pinError, togglePin] = usePinToggle(reload);
  return (
    <Shell title="모임" menu={common.menu} notice={common.notice} onNoticeClose={common.onNoticeClose}>
      {pinError && <p className="list-error">{pinError}</p>}
      {load.state === "loading" && <p className="list-note">불러오는 중…</p>}
      {load.state === "error" && <p className="list-note">{load.message}</p>}
      {load.state === "ok" && load.value.pinned_channels.length > 0 && (
        <section className="list-section">
          <h2 className="list-section-title">고정한 채널</h2>
          {load.value.pinned_channels.map((channel) => (
            <ChannelRow
              key={channel.id}
              channel={{ ...channel, pinned: true }}
              sub={channel.group_name}
              onOpen={(item) => onOpenChannel(item.group_id, item)}
              onPin={(item) => togglePin("channel", item.id, false)}
            />
          ))}
        </section>
      )}
      {load.state === "ok" && load.value.groups.length === 0 && (
        <p className="list-note">이 계정으로 볼 수 있는 모임이 없어요.</p>
      )}
      {load.state === "ok" && load.value.groups.length > 0 && (
        <section className="list-section">
          {load.value.pinned_channels.length > 0 && <h2 className="list-section-title">모임</h2>}
          {load.value.groups.map((group) => (
            <div
              key={group.id}
              className={group.unread ? "list-item list-item-unread" : "list-item"}
              role="button"
              tabIndex={0}
              onClick={() => onOpen(group.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onOpen(group.id);
              }}
            >
              <GroupIcon group={group} />
              <span className="list-name">{group.name}</span>
              <Badge unread={group.unread} mentions={group.mentions} />
              <PinButton
                pinned={Boolean(group.pinned)}
                onToggle={() => togglePin("group", group.id, !group.pinned)}
              />
            </div>
          ))}
        </section>
      )}
    </Shell>
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
  const [load, reload] = useLoad<GroupChannels>(
    () => fetchGroupChannels(groupId),
    [groupId, activeChannelId],
    common.onAuthLost,
  );
  const [pinError, togglePin] = usePinToggle(reload);
  const group = load.state === "ok" ? load.value.group : null;
  return (
    <Shell
      title={group?.name ?? "…"}
      onBack={onBack}
      menu={common.menu}
      extra={
        group && (
          <PinButton pinned={Boolean(group.pinned)} onToggle={() => togglePin("group", group.id, !group.pinned)} />
        )
      }
      notice={common.notice}
      onNoticeClose={common.onNoticeClose}
    >
      {pinError && <p className="list-error">{pinError}</p>}
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
                active={channel.id === activeChannelId}
                onOpen={onOpen}
                onPin={(item) => togglePin("channel", item.id, !item.pinned)}
              />
            ))}
          </section>
        ))}
    </Shell>
  );
}

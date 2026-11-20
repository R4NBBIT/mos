import { type ReactNode, useEffect, useState } from "react";
import { ApiError, fetchGroupChannels, fetchGroups } from "./api";
import { isDiscordMediaUrl } from "./format";
import type { ChannelInfo, Group, GroupChannels } from "./types";

const RETRY_MAX_MS = 15_000;

type Load<T> = { state: "loading" } | { state: "ok"; value: T } | { state: "error"; message: string };

/** 목록 불러오기. 봇이 막 켜져 503이면 붙을 때까지 다시 묻는다 */
function useLoad<T>(loader: () => Promise<T>, deps: unknown[], onAuthLost: () => void): Load<T> {
  const [load, setLoad] = useState<Load<T>>({ state: "loading" });
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    setLoad({ state: "loading" });
    const attempt = async (delayMs: number) => {
      try {
        const value = await loader();
        if (!stopped) setLoad({ state: "ok", value });
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
        setLoad({
          state: "error",
          message:
            caught instanceof ApiError && caught.status === 503
              ? "연결하는 중이에요…"
              : "불러오지 못했어요. 다시 시도하는 중…",
        });
        timer = window.setTimeout(() => void attempt(Math.min(delayMs * 2, RETRY_MAX_MS)), delayMs);
      }
    };
    void attempt(1000);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, deps);
  return load;
}

function GroupIcon({ group }: { group: Group }) {
  if (isDiscordMediaUrl(group.icon_url)) {
    return <img className="group-icon" src={group.icon_url} alt="" loading="lazy" referrerPolicy="no-referrer" />;
  }
  return <div className="group-icon group-icon-fallback">{group.name.slice(0, 1)}</div>;
}

function Shell({
  title,
  sub,
  onBack,
  menu,
  notice,
  onNoticeClose,
  children,
}: {
  title: string;
  sub?: string;
  onBack?: () => void;
  menu: ReactNode;
  notice?: string;
  onNoticeClose?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="room">
      <header className="room-header">
        {onBack && (
          <button type="button" className="back-button" onClick={onBack} aria-label="뒤로">
            ‹
          </button>
        )}
        <div className="room-title">
          <strong>{title}</strong>
          {sub && <span className="room-sub">{sub}</span>}
        </div>
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

export function GroupList({ onOpen, ...common }: CommonProps & { onOpen: (groupId: string) => void }) {
  const load = useLoad(fetchGroups, [], common.onAuthLost);
  return (
    <Shell title="모임" menu={common.menu} notice={common.notice} onNoticeClose={common.onNoticeClose}>
      {load.state === "loading" && <p className="list-note">불러오는 중…</p>}
      {load.state === "error" && <p className="list-note">{load.message}</p>}
      {load.state === "ok" && load.value.length === 0 && (
        <p className="list-note">이 계정으로 볼 수 있는 모임이 없어요.</p>
      )}
      {load.state === "ok" &&
        load.value.map((group) => (
          <button key={group.id} type="button" className="list-item" onClick={() => onOpen(group.id)}>
            <GroupIcon group={group} />
            <span className="list-name">{group.name}</span>
          </button>
        ))}
    </Shell>
  );
}

function groupByCategory(channels: ChannelInfo[]): { name: string | null; channels: ChannelInfo[] }[] {
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
  onOpen,
  onBack,
  ...common
}: CommonProps & { groupId: string; onOpen: (channelId: string) => void; onBack: () => void }) {
  const load = useLoad<GroupChannels>(() => fetchGroupChannels(groupId), [groupId], common.onAuthLost);
  const title = load.state === "ok" ? load.value.group.name : "…";
  return (
    <Shell
      title={title}
      onBack={onBack}
      menu={common.menu}
      notice={common.notice}
      onNoticeClose={common.onNoticeClose}
    >
      {load.state === "loading" && <p className="list-note">불러오는 중…</p>}
      {load.state === "error" && <p className="list-note">{load.message}</p>}
      {load.state === "ok" && load.value.channels.length === 0 && (
        <p className="list-note">이 계정으로 볼 수 있는 채널이 없어요.</p>
      )}
      {load.state === "ok" &&
        groupByCategory(load.value.channels).map((section) => (
          <section key={section.name ?? "-"} className="list-section">
            {section.name && <h2 className="list-section-title">{section.name}</h2>}
            {section.channels.map((channel) =>
              channel.kind === "forum" ? (
                <div key={channel.id} className="list-item list-item-disabled" title="포럼은 다음 단계에서 열려요">
                  <span className="channel-mark">▤</span>
                  <span className="list-name">{channel.name}</span>
                  <span className="list-badge">준비 중</span>
                </div>
              ) : (
                <button key={channel.id} type="button" className="list-item" onClick={() => onOpen(channel.id)}>
                  <span className="channel-mark">{channel.kind === "news" ? "📢" : "#"}</span>
                  <span className="list-name">{channel.name}</span>
                  {!channel.can_send && <span className="list-badge">읽기만</span>}
                </button>
              ),
            )}
          </section>
        ))}
    </Shell>
  );
}

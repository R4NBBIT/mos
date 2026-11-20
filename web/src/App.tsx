import { useCallback, useEffect, useRef, useState } from "react";
import AccountMenu from "./AccountMenu";
import { fetchSession, fetchSettings, lock } from "./api";
import { ConnectScreen, PasswordSetup, ReconnectScreen, UnlockScreen } from "./AuthScreens";
import { authText } from "./authText";
import ChatRoom from "./ChatRoom";
import { ChannelList, GroupList } from "./Lists";
import Posts from "./Posts";
import SettingsScreen from "./SettingsScreen";
import { applyLook, cachedLook, type Settings } from "./theme";
import type { ChannelInfo, SessionAccount, SessionState } from "./types";

// 서버의 자동 잠금(30분)과 같게. 조작이 없으면 화면도 잠금으로 간다
const AUTO_LOCK_MS = 30 * 60 * 1000;
const IDLE_CHECK_MS = 30 * 1000;
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

/** 계정 연결에서 돌아올 때 주소에 붙는 오류를 읽고 주소는 깨끗이 지운다 */
function takeConnectError(): string {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("connect_error");
  if (code === null) return "";
  window.history.replaceState(null, "", window.location.pathname + window.location.hash);
  return authText(code);
}

type Route =
  | { view: "groups" }
  | { view: "settings" }
  | { view: "channels"; groupId: string }
  | { view: "chat"; groupId: string; channelId: string }
  | { view: "posts"; groupId: string; parentId: string }
  | { view: "thread"; groupId: string; parentId: string; threadId: string };

/**
 * 주소 # 뒤: #/ 모임 목록, #/g/모임 채널 목록, #/g/모임/c/채널 채팅방,
 * #/g/모임/p/채널 포럼 글·스레드 목록, #/g/모임/p/채널/t/글 글(스레드) 채팅. ID는 숫자만 받는다
 */
function parseRoute(hash: string): Route {
  if (hash === "#/settings") return { view: "settings" };
  const thread = /^#\/g\/(\d{1,21})\/p\/(\d{1,21})\/t\/(\d{1,21})$/.exec(hash);
  if (thread?.[1] && thread[2] && thread[3]) {
    return { view: "thread", groupId: thread[1], parentId: thread[2], threadId: thread[3] };
  }
  const posts = /^#\/g\/(\d{1,21})\/p\/(\d{1,21})$/.exec(hash);
  if (posts?.[1] && posts[2]) return { view: "posts", groupId: posts[1], parentId: posts[2] };
  const chat = /^#\/g\/(\d{1,21})\/c\/(\d{1,21})$/.exec(hash);
  if (chat?.[1] && chat[2]) return { view: "chat", groupId: chat[1], channelId: chat[2] };
  const channels = /^#\/g\/(\d{1,21})$/.exec(hash);
  if (channels?.[1]) return { view: "channels", groupId: channels[1] };
  return { view: "groups" };
}

function useHashRoute(): [Route, (hash: string) => void] {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const go = useCallback((hash: string) => {
    window.location.hash = hash; // 브라우저 뒤로 가기로 돌아올 수 있게 기록에 남긴다
  }, []);
  return [route, go];
}

const WIDE_QUERY = "(min-width: 900px)";

/** 넓은 창(900px 이상)이면 목록 + 채팅방 2단 */
function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(WIDE_QUERY);
    const onChange = () => setWide(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return wide;
}

function pickActive(session: SessionState): SessionAccount | null {
  return (
    session.accounts.find((account) => account.id === session.active_account_id) ??
    session.accounts[0] ??
    null
  );
}

function useIdleLock(enabled: boolean, onLocked: () => void) {
  const lastActive = useRef(Date.now());
  useEffect(() => {
    if (!enabled) return;
    lastActive.current = Date.now();
    const mark = () => {
      lastActive.current = Date.now();
    };
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, mark, { passive: true });
    const timer = window.setInterval(() => {
      if (Date.now() - lastActive.current >= AUTO_LOCK_MS) {
        void lock().finally(onLocked);
      }
    }, IDLE_CHECK_MS);
    return () => {
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, mark);
      window.clearInterval(timer);
    };
  }, [enabled, onLocked]);
}

export default function App() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState(takeConnectError);
  const [route, go] = useHashRoute();
  const wide = useWide();
  const [look, setLook] = useState<Settings>(cachedLook);
  useEffect(() => applyLook(look), [look]);

  const refresh = useCallback(async () => {
    try {
      setSession(await fetchSession());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  const changed = useCallback(() => {
    setNotice("");
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();
    // 다른 탭에서 잠그거나 계정을 바꿨을 수 있어, 탭으로 돌아오면 다시 확인
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  const active = session ? pickActive(session) : null;
  const open = Boolean(active && !active.locked && active.password_set && !active.disconnected);
  const openAccountId = open ? active?.id : undefined;
  // 열린 계정의 설정(테마·탭 제목)을 받아 온다. 계정을 바꾸면 그 계정 것으로
  useEffect(() => {
    if (!openAccountId) return;
    let stopped = false;
    fetchSettings()
      .then((value) => {
        if (!stopped) setLook(value);
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [openAccountId]);
  useIdleLock(open && !active?.kept, changed);

  if (session === null) {
    return (
      <div className="center-note">
        {failed ? "서버에 연결할 수 없어요. 잠시 후 새로고침해 주세요." : "불러오는 중…"}
      </div>
    );
  }
  if (active === null) {
    return <ConnectScreen notice={notice} />;
  }
  if (active.can_set_password) {
    return <PasswordSetup account={active} onDone={changed} />;
  }
  if (active.disconnected || !active.password_set) {
    return <ReconnectScreen account={active} notice={notice} onChanged={changed} />;
  }
  if (active.locked) {
    return <UnlockScreen session={session} account={active} notice={notice} onChanged={changed} />;
  }
  const common = {
    menu: (
      <AccountMenu
        session={session}
        account={active}
        onChanged={changed}
        onOpenSettings={() => go("#/settings")}
      />
    ),
    onAuthLost: changed,
    notice,
    onNoticeClose: () => setNotice(""),
  };
  const openChannel = (groupId: string, channel: ChannelInfo) =>
    go(channel.kind === "forum" ? `#/g/${groupId}/p/${channel.id}` : `#/g/${groupId}/c/${channel.id}`);
  const groupList = (
    <GroupList
      key={active.id}
      onOpen={(groupId) => go(`#/g/${groupId}`)}
      onOpenChannel={openChannel}
      {...common}
    />
  );
  const channelList = (groupId: string, activeChannelId?: string) => (
    <ChannelList
      key={`${active.id}:${groupId}`}
      groupId={groupId}
      activeChannelId={activeChannelId}
      onBack={() => go("#/")}
      onOpen={(channel) => openChannel(groupId, channel)}
      {...common}
    />
  );
  const chatRoom = (groupId: string, channelId: string, inSplit: boolean, parentId?: string) => (
    <ChatRoom
      key={`${active.id}:${channelId}`}
      channelId={channelId}
      myUserId={active.user_id}
      showBack={!inSplit || Boolean(parentId)}
      onBack={() => go(parentId ? `#/g/${groupId}/p/${parentId}` : `#/g/${groupId}`)}
      onOpenThreads={parentId ? undefined : () => go(`#/g/${groupId}/p/${channelId}`)}
      menu={inSplit ? null : common.menu}
      onAuthLost={changed}
      notice={inSplit ? "" : notice}
      onNoticeClose={common.onNoticeClose}
      theme={look.theme}
      onOpenChannel={(channel) => openChannel(groupId, channel)}
    />
  );

  const posts = (groupId: string, parentId: string, inSplit: boolean) => (
    <Posts
      key={`${active.id}:${parentId}`}
      parentId={parentId}
      showBack
      menu={inSplit ? null : common.menu}
      onBack={(parent) =>
        go(parent && parent.kind !== "forum" ? `#/g/${groupId}/c/${parentId}` : `#/g/${groupId}`)
      }
      onOpen={(threadId) => go(`#/g/${groupId}/p/${parentId}/t/${threadId}`)}
      onAuthLost={changed}
    />
  );

  if (route.view === "settings") {
    return (
      <SettingsScreen
        settings={look}
        onChange={setLook}
        onBack={() => window.history.back()}
        menu={common.menu}
      />
    );
  }

  // 시트 테마의 대화방은 화면 전체가 문서 한 장이다(채널은 아래 시트 탭으로)
  const sheetRoom = look.theme === "sheet" && (route.view === "chat" || route.view === "thread");
  if (wide && !sheetRoom) {
    return (
      <div className="split">
        <aside className="split-list">
          {route.view === "groups"
            ? groupList
            : channelList(
                route.groupId,
                route.view === "chat" ? route.channelId : route.view === "channels" ? undefined : route.parentId,
              )}
        </aside>
        <main className="split-main">
          {route.view === "chat" ? (
            chatRoom(route.groupId, route.channelId, true)
          ) : route.view === "posts" ? (
            posts(route.groupId, route.parentId, true)
          ) : route.view === "thread" ? (
            chatRoom(route.groupId, route.threadId, true, route.parentId)
          ) : (
            <div className="split-empty">왼쪽에서 {route.view === "groups" ? "모임" : "채널"}을 골라 주세요.</div>
          )}
        </main>
      </div>
    );
  }
  if (route.view === "chat") return chatRoom(route.groupId, route.channelId, false);
  if (route.view === "posts") return posts(route.groupId, route.parentId, false);
  if (route.view === "thread") return chatRoom(route.groupId, route.threadId, false, route.parentId);
  if (route.view === "channels") return channelList(route.groupId);
  return groupList;
}

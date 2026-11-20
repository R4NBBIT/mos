import { useCallback, useEffect, useRef, useState } from "react";
import AccountMenu from "./AccountMenu";
import { fetchSession, lock } from "./api";
import { ConnectScreen, PasswordSetup, ReconnectScreen, UnlockScreen } from "./AuthScreens";
import { authText } from "./authText";
import ChatRoom from "./ChatRoom";
import { ChannelList, GroupList } from "./Lists";
import type { SessionAccount, SessionState } from "./types";

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

type Route = { view: "groups" } | { view: "channels"; groupId: string } | { view: "chat"; groupId: string; channelId: string };

/** 주소 # 뒤: #/ 모임 목록, #/g/모임 채널 목록, #/g/모임/c/채널 채팅방. ID는 숫자만 받는다 */
function parseRoute(hash: string): Route {
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
    menu: <AccountMenu session={session} account={active} onChanged={changed} />,
    onAuthLost: changed,
    notice,
    onNoticeClose: () => setNotice(""),
  };
  const groupList = (
    <GroupList
      key={active.id}
      onOpen={(groupId) => go(`#/g/${groupId}`)}
      onOpenChannel={(groupId, channelId) => go(`#/g/${groupId}/c/${channelId}`)}
      {...common}
    />
  );
  const channelList = (groupId: string, activeChannelId?: string) => (
    <ChannelList
      key={`${active.id}:${groupId}`}
      groupId={groupId}
      activeChannelId={activeChannelId}
      onBack={() => go("#/")}
      onOpen={(channelId) => go(`#/g/${groupId}/c/${channelId}`)}
      {...common}
    />
  );
  const chatRoom = (groupId: string, channelId: string, inSplit: boolean) => (
    <ChatRoom
      key={`${active.id}:${channelId}`}
      channelId={channelId}
      myUserId={active.user_id}
      showBack={!inSplit}
      onBack={() => go(`#/g/${groupId}`)}
      menu={inSplit ? null : common.menu}
      onAuthLost={changed}
      notice={inSplit ? "" : notice}
      onNoticeClose={common.onNoticeClose}
    />
  );

  if (wide) {
    return (
      <div className="split">
        <aside className="split-list">
          {route.view === "groups"
            ? groupList
            : channelList(route.groupId, route.view === "chat" ? route.channelId : undefined)}
        </aside>
        <main className="split-main">
          {route.view === "chat" ? (
            chatRoom(route.groupId, route.channelId, true)
          ) : (
            <div className="split-empty">왼쪽에서 {route.view === "groups" ? "모임" : "채널"}을 골라 주세요.</div>
          )}
        </main>
      </div>
    );
  }
  if (route.view === "chat") return chatRoom(route.groupId, route.channelId, false);
  if (route.view === "channels") return channelList(route.groupId);
  return groupList;
}

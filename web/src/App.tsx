import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import AccountMenu from "./AccountMenu";
import BossScreen from "./boss/BossScreen";
import { DOUBLE_PRESS_MS, keyFromEvent, parseBossKey, sameKey } from "./boss/bossKey";
import { isCapturingKey, setDisguised } from "./boss/bossState";
import { loadMyFile } from "./boss/myFile";
import { buildTemplate, type Workbook } from "./boss/templates";
import { fetchSession, fetchSettings, lock, updateSettings } from "./api";
import { ConnectScreen, PasswordSetup, ReconnectScreen, UnlockScreen } from "./AuthScreens";
import { authText } from "./authText";
import ChatRoom from "./ChatRoom";
import Guide from "./Guide";
import { ChannelList, GroupList } from "./Lists";
import Posts from "./Posts";
import SettingsScreen from "./SettingsScreen";
import { applyDisguise, applyLook, type BossTemplate, cachedLook, type Settings } from "./theme";
import type { ChannelInfo, SessionAccount, SessionState } from "./types";
import { useNotifications } from "./useNotifications";

// 서버의 자동 잠금(계정 설정, 기본 30분)과 같게. 조작이 없으면 화면도 잠금으로 간다
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

const LIST_OPEN_KEY = "mos.splitList.v1";

/** 넓은 창 왼쪽 목록을 펼쳐 둘지(이 브라우저에만 기억, 저장이 안 되면 펼친 채로) */
function useListOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      return window.localStorage.getItem(LIST_OPEN_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  const change = useCallback((next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(LIST_OPEN_KEY, next ? "open" : "closed");
    } catch {
      // 저장소를 못 쓰면 이번 화면에서만
    }
  }, []);
  return [open, change];
}

function pickActive(session: SessionState): SessionAccount | null {
  return (
    session.accounts.find((account) => account.id === session.active_account_id) ??
    session.accounts[0] ??
    null
  );
}

function useIdleLock(enabled: boolean, lockMinutes: number, onLocked: () => void) {
  const lastActive = useRef(Date.now());
  useEffect(() => {
    if (!enabled) return;
    lastActive.current = Date.now();
    const mark = () => {
      lastActive.current = Date.now();
    };
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, mark, { passive: true });
    const timer = window.setInterval(() => {
      if (Date.now() - lastActive.current >= lockMinutes * 60 * 1000) {
        void lock().finally(onLocked);
      }
    }, IDLE_CHECK_MS);
    return () => {
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, mark);
      window.clearInterval(timer);
    };
  }, [enabled, lockMinutes, onLocked]);
}

interface ScreensProps {
  look: Settings;
  setLook: (settings: Settings) => void;
  /** 바뀌면 세션을 다시 받는다(위장 화면에서 돌아오며 잠갔을 때) */
  refreshKey: number;
  onFileChanged: () => void;
}

function Screens({ look, setLook, refreshKey, onFileChanged }: ScreensProps) {
  const [session, setSession] = useState<SessionState | null>(null);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState(takeConnectError);
  const [route, go] = useHashRoute();
  const wide = useWide();
  const [listOpen, setListOpen] = useListOpen();

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

  useEffect(() => {
    if (refreshKey > 0) changed();
  }, [refreshKey, changed]);

  const active = session ? pickActive(session) : null;
  const open = Boolean(active && !active.locked && active.password_set && !active.disconnected);
  const openAccountId = open ? active?.id : undefined;
  // 열린 계정의 설정(테마·탭 제목)을 받아 온다. 계정을 바꾸면 그 계정 것으로
  const [showGuide, setShowGuide] = useState(false);
  useEffect(() => {
    if (!openAccountId) return;
    let stopped = false;
    setShowGuide(false);
    fetchSettings()
      .then((value) => {
        if (stopped) return;
        setLook(value);
        if (!value.guide_done) setShowGuide(true); // 이 계정으로 처음 들어왔으면 사용 안내
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [openAccountId]);
  useIdleLock(open && !active?.kept, look.lock_minutes, changed);
  const closeGuide = useCallback(() => {
    setShowGuide(false);
    if (look.guide_done) return;
    setLook({ ...look, guide_done: true });
    updateSettings({ guide_done: true }).catch(() => {}); // 못 남기면 다음에 한 번 더 보일 뿐
  }, [look, setLook]);
  useNotifications({
    enabled: open && look.notify,
    scope: look.notify_scope,
    preview: look.notify_preview,
    accountId: openAccountId,
    currentChannel: route.view === "chat" ? route.channelId : route.view === "thread" ? route.threadId : null,
    onOpen: go,
  });

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
  const screen = (): ReactNode => {
    const common = {
      menu: (
        <AccountMenu
          session={session}
          account={active}
          onChanged={changed}
          onOpenSettings={() => go("#/settings")}
        onOpenGuide={() => setShowGuide(true)}
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
        theme={look.theme}
        onOpenChannel={(channel) => openChannel(groupId, channel)}
      />
    );

    if (route.view === "settings") {
      return (
        <SettingsScreen
          settings={look}
          onChange={setLook}
          onBack={() => window.history.back()}
          menu={common.menu}
          onFileChanged={onFileChanged}
        />
      );
    }

    // 목록 없이 한 화면(좁은 창, 또는 넓은 창에서 목록을 접었을 때)
    const single = () => {
      if (route.view === "chat") return chatRoom(route.groupId, route.channelId, false);
      if (route.view === "posts") return posts(route.groupId, route.parentId, false);
      if (route.view === "thread") return chatRoom(route.groupId, route.threadId, false, route.parentId);
      if (route.view === "channels") return channelList(route.groupId);
      return groupList;
    };
    if (!wide) return single();

    const toggle = (
      <button
        type="button"
        className="split-toggle"
        aria-expanded={listOpen}
        aria-label={listOpen ? "왼쪽 목록 접기" : "왼쪽 목록 펼치기"}
        title={listOpen ? "목록 접기" : "목록 펼치기"}
        onClick={() => setListOpen(!listOpen)}
      >
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <path d={listOpen ? "M10 3 5 8l5 5" : "m6 3 5 5-5 5"} fill="none" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      </button>
    );
    if (!listOpen) {
      return (
        <div className="split split-closed">
          {toggle}
          <main className="split-main">{single()}</main>
        </div>
      );
    }
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
        {toggle}
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
  };
  return (
    <>
      {screen()}
      {showGuide && <Guide settings={look} wide={wide} onClose={closeGuide} />}
    </>
  );
}

/** 위장 화면에 쓸 표: 고른 템플릿(날짜는 오늘 기준) 또는 불러온 내 파일 */
function pickWorkbook(
  template: BossTemplate,
  day: string,
  fileVersion: number,
): { workbook: Workbook; storageKey: string } {
  void day; // 날짜가 바뀌면 템플릿 날짜도 새로
  void fileVersion; // 내 파일을 새로 불러오면 다시 읽기
  if (template === "myfile") {
    const file = loadMyFile();
    if (file) return { workbook: file, storageKey: `mos.boss.edits.v1.myfile.${file.stamp}` };
  }
  const id = template === "myfile" ? "weekly" : template;
  return { workbook: buildTemplate(id), storageKey: `mos.boss.edits.v1.${id}` };
}

/** 화면 맨 위: 평소 화면 + 위장 화면(SCR-12). 위장 화면은 미리 그려 두고 숨겼다 보였다만 한다 */
export default function App() {
  const [look, setLook] = useState<Settings>(cachedLook);
  const [bossOn, setBossOn] = useState(false);
  const [fileVersion, setFileVersion] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const day = new Date().toDateString();
  const { workbook, storageKey } = useMemo(
    () => pickWorkbook(look.boss_template, day, fileVersion),
    [look.boss_template, day, fileVersion],
  );

  useEffect(() => {
    setDisguised(bossOn);
    if (bossOn) applyDisguise(workbook.fileName);
    else applyLook(look);
  }, [bossOn, look, workbook.fileName]);

  const relock = look.boss_relock;
  const toggle = useCallback(
    (on?: boolean) => {
      setBossOn((current) => {
        const next = on ?? !current;
        if (current && !next && relock) {
          // 돌아올 때 잠그기: 잠그고 잠금 화면으로
          void lock()
            .catch(() => {})
            .finally(() => setRefreshKey((key) => key + 1));
        }
        return next;
      });
    },
    [relock],
  );

  // 보스키(기본 Esc 두 번, 사람마다 바꿀 수 있음). 어느 화면에서나
  const bossKey = look.boss_key;
  useEffect(() => {
    const wanted = parseBossKey(bossKey);
    let last = 0;
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || isCapturingKey()) return;
      const pressed = keyFromEvent(event);
      if (!pressed || !sameKey(pressed, wanted)) {
        last = 0;
        return;
      }
      if (!wanted.double) {
        event.preventDefault();
        toggle();
        return;
      }
      const now = Date.now();
      if (now - last <= DOUBLE_PRESS_MS) {
        last = 0;
        event.preventDefault();
        toggle();
      } else last = now;
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [toggle, bossKey]);

  // 자동 위장(선택): 창에서 벗어나거나 마우스가 창 밖으로 나가면
  useEffect(() => {
    if (!look.boss_auto || bossOn) return;
    const choosingFile = () => document.activeElement instanceof HTMLInputElement && document.activeElement.type === "file";
    const onBlur = () => {
      if (!choosingFile()) toggle(true);
    };
    const onLeave = (event: MouseEvent) => {
      if (event.relatedTarget === null && !choosingFile()) toggle(true);
    };
    window.addEventListener("blur", onBlur);
    document.addEventListener("mouseout", onLeave);
    return () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("mouseout", onLeave);
    };
  }, [look.boss_auto, bossOn, toggle]);

  return (
    <>
      <div className="app-root" inert={bossOn} aria-hidden={bossOn || undefined}>
        <Screens
          look={look}
          setLook={setLook}
          refreshKey={refreshKey}
          onFileChanged={() => setFileVersion((version) => version + 1)}
        />
      </div>
      <div className="boss-layer" hidden={!bossOn}>
        <BossScreen workbook={workbook} storageKey={storageKey} active={bossOn} />
      </div>
      <button
        type="button"
        className="boss-corner-button"
        tabIndex={-1}
        aria-label="화면 전환"
        onClick={() => toggle()}
      />
    </>
  );
}

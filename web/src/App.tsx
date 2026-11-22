import { usePresence } from "./motion";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import AccountMenu from "./AccountMenu";
import BossScreen from "./boss/BossScreen";
import { DOUBLE_PRESS_MS, keyFromEvent, parseBossKey, sameKey } from "./boss/bossKey";
import { type AssetList, cachedInfo, fetchBossInfo, loadAsset, uploadAsset } from "./boss/bossStore";
import { isCapturingKey, isDisguised, setDisguised } from "./boss/bossState";
import { loadMyFile, type StoredFile } from "./boss/myFile";
import { docTitle, memoExample, NoteDisguise, noteExample, WordDisguise, wordExample } from "./boss/DocDisguise";
import { EDIT_KEYS, ImageDisguise, TextDisguise } from "./boss/OtherDisguise";
import { buildTemplate, type TemplateId, type Workbook } from "./boss/templates";
import {
  fetchNotifyPrefs,
  fetchSession,
  fetchSettings,
  lock,
  saveNotifyPrefs,
  type SettingsChanges,
  updateSettings,
} from "./api";
import {
  cleanNotifyPrefs,
  DEFAULT_NOTIFY_PREFS,
  type NotifyPrefs,
  NotifyPrefsContext,
  type NotifyPrefsValue,
} from "./notifyPrefs";
import { ConnectScreen, PasswordSetup, ReconnectScreen, UnlockScreen } from "./AuthScreens";
import { authText } from "./authText";
import ChatRoom from "./ChatRoom";
import Guide from "./Guide";
import SplitToggle, { SplitContext } from "./SplitToggle";
import { ChannelList, GroupList } from "./Lists";
import Posts from "./Posts";
import SettingsScreen from "./SettingsScreen";
import WordChrome from "./WordChrome";
import { LookContext, type LookValue } from "./lookContext";
import { applyDisguise, applyLook, type BossTemplate, cachedLook, type Settings } from "./theme";
import type { ChannelInfo, SessionAccount, SessionState, VoiceChannel } from "./types";
import VoiceRoom from "./VoiceRoom";
import InstallDialog from "./InstallDialog";
import NotifyToast from "./NotifyToast";
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
  | { view: "voice"; groupId: string; channelId: string }
  | { view: "posts"; groupId: string; parentId: string }
  | { view: "thread"; groupId: string; parentId: string; threadId: string };

/**
 * 주소 # 뒤: #/ 모임 목록, #/g/모임 채널 목록, #/g/모임/c/채널 채팅방,
 * #/g/모임/p/채널 포럼 글, 스레드 목록, #/g/모임/p/채널/t/글 글(스레드) 채팅,
 * #/g/모임/v/채널 음성 채널(누가 있는지). ID는 숫자만 받는다
 */
function parseRoute(hash: string): Route {
  if (hash === "#/settings") return { view: "settings" };
  const thread = /^#\/g\/(\d{1,21})\/p\/(\d{1,21})\/t\/(\d{1,21})$/.exec(hash);
  if (thread?.[1] && thread[2] && thread[3]) {
    return { view: "thread", groupId: thread[1], parentId: thread[2], threadId: thread[3] };
  }
  const posts = /^#\/g\/(\d{1,21})\/p\/(\d{1,21})$/.exec(hash);
  if (posts?.[1] && posts[2]) return { view: "posts", groupId: posts[1], parentId: posts[2] };
  const voice = /^#\/g\/(\d{1,21})\/v\/(\d{1,21})$/.exec(hash);
  if (voice?.[1] && voice[2]) return { view: "voice", groupId: voice[1], channelId: voice[2] };
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

const WIDE_QUERY = "(min-width: 641px)"; // 휴대폰보다 넓으면 왼쪽 목록(접기, 펴기)

/** 넓은 창(641px 이상)이면 목록 + 채팅방 2단 */
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
  /** 열린 계정이 바뀌면(위장 파일을 그 계정 것으로 다시 받는다) */
  onAccountOpen: (accountId: string | undefined) => void;
}

function Screens({ look, setLook, refreshKey, onFileChanged, onAccountOpen }: ScreensProps) {
  const [session, setSession] = useState<SessionState | null>(null);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState(takeConnectError);
  const [route, go] = useHashRoute();
  const wide = useWide();
  const [listOpen, setListOpen] = useListOpen();
  const listPresence = usePresence(listOpen, 240);
  // 넓은 화면 왼쪽 목록에서 둘러보는 서버(null이면 서버 목록). 오른쪽 화면과 따로 움직이고,
  // 채널을 열거나 뒤로 가서 주소가 바뀌면 다시 주소를 따른다
  const [browse, setBrowse] = useState<{ from: Route; groupId: string | null } | null>(null);

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
  const guidePresence = usePresence(showGuide);
  const [showInstall, setShowInstall] = useState(false);
  const installPresence = usePresence(showInstall);
  const closeInstall = useCallback(() => setShowInstall(false), []);
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
  // 이 기기의 알림 설정(기기마다 따로). 받기 전에는 알림을 켜지 않는다(꺼 둔 기기에서 잠깐 울리지 않게)
  const [notifyPrefs, setNotifyPrefs] = useState<NotifyPrefs | null>(null);
  useEffect(() => {
    setNotifyPrefs(null);
    if (!openAccountId) return;
    let stopped = false;
    fetchNotifyPrefs()
      .then((value) => {
        if (!stopped) setNotifyPrefs(cleanNotifyPrefs(value));
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [openAccountId]);
  const notifyPrefsValue = useMemo<NotifyPrefsValue>(
    () => ({
      prefs: notifyPrefs ?? DEFAULT_NOTIFY_PREFS,
      save: async (changes) => {
        const before = notifyPrefs;
        if (before) setNotifyPrefs({ ...before, ...changes });
        try {
          setNotifyPrefs(cleanNotifyPrefs(await saveNotifyPrefs(changes)));
        } catch {
          setNotifyPrefs(before);
        }
      },
    }),
    [notifyPrefs],
  );
  useIdleLock(open && !active?.kept, look.lock_minutes, changed);
  useEffect(() => onAccountOpen(openAccountId), [openAccountId, onAccountOpen]);
  // 화면에서 바로 고치는 설정(문서 제목, 탭 제목). 바로 보이게 하고 실패하면 되돌린다
  const lookRef = useRef(look);
  lookRef.current = look;
  const lookValue = useMemo<LookValue>(
    () => ({
      settings: look,
      save: async (changes: SettingsChanges) => {
        const before = lookRef.current;
        const { doc_titles: titleChanges, list_order: orderChanges, ...rest } = changes;
        const titles = { ...before.doc_titles };
        for (const [key, title] of Object.entries(titleChanges ?? {})) {
          if (title) titles[key] = title;
          else delete titles[key];
        }
        const orders = { ...before.list_order };
        for (const [key, ids] of Object.entries(orderChanges ?? {})) {
          if (ids && ids.length > 0) orders[key] = ids;
          else delete orders[key];
        }
        setLook({ ...before, ...rest, doc_titles: titles, list_order: orders });
        try {
          setLook(await updateSettings(changes));
        } catch {
          setLook(before);
        }
      },
    }),
    [look, setLook],
  );
  const closeGuide = useCallback(() => {
    setShowGuide(false);
    if (look.guide_done) return;
    setLook({ ...look, guide_done: true });
    updateSettings({ guide_done: true }).catch(() => {}); // 못 남기면 다음에 한 번 더 보일 뿐
  }, [look, setLook]);
  const notify = useNotifications({
    enabled: open && Boolean(notifyPrefs?.notify),
    scope: notifyPrefs?.scope ?? "pinned",
    preview: Boolean(notifyPrefs?.preview),
    boss: Boolean(notifyPrefs?.boss),
    accountId: openAccountId,
    currentChannel: route.view === "chat" ? route.channelId : route.view === "thread" ? route.threadId : null,
    currentForum: route.view === "posts" ? route.parentId : null,
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
          onOpenInstall={() => setShowInstall(true)}
        />
      ),
      onAuthLost: changed,
      notice,
      onNoticeClose: () => setNotice(""),
    };
    const openChannel = (groupId: string, channel: ChannelInfo) =>
      go(channel.kind === "forum" ? `#/g/${groupId}/p/${channel.id}` : `#/g/${groupId}/c/${channel.id}`);
    const openVoice = (groupId: string, voice: VoiceChannel) => go(`#/g/${groupId}/v/${voice.id}`);
    // 넓은 화면 왼쪽 목록에는 계정 메뉴·안내를 두지 않는다(계정 메뉴는 늘 오른쪽 위 같은 자리)
    const listSide = { ...common, menu: null, notice: "" };
    const browseTo = (groupId: string | null) => setBrowse({ from: route, groupId });
    const groupList = (side = false) => (
      <GroupList
        key={look.theme === "note" ? `${active.id}:tree` : active.id}
        tree={look.theme === "note"}
        onOpen={(groupId) => (side ? browseTo(groupId) : go(`#/g/${groupId}`))}
        onOpenChannel={openChannel}
        onOpenVoice={openVoice}
        {...(side ? listSide : common)}
      />
    );
    const channelList = (groupId: string, activeChannelId?: string, side = false) =>
      look.theme === "note" ? (
        // 노션: 서버 목록 안에서 그 서버를 펼친 트리 하나로
        <GroupList
          key={`${active.id}:tree`}
          tree
          openGroupId={groupId}
          activeChannelId={activeChannelId}
          onOpen={(id) => (side ? browseTo(id) : go(`#/g/${id}`))}
          onOpenChannel={openChannel}
          onOpenVoice={openVoice}
          {...(side ? listSide : common)}
        />
      ) : (
        <ChannelList
          key={`${active.id}:${groupId}`}
          groupId={groupId}
          activeChannelId={activeChannelId}
          onBack={() => (side ? browseTo(null) : go("#/"))}
          onSwitch={(id) => (side ? browseTo(id) : go(`#/g/${id}`))}
          onOpen={(channel) => openChannel(groupId, channel)}
          onOpenVoice={(voice) => openVoice(groupId, voice)}
          {...(side ? listSide : common)}
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
        menu={common.menu}
        onAuthLost={changed}
        notice={notice}
        onNoticeClose={common.onNoticeClose}
        theme={look.theme}
        onOpenChannel={(channel) => openChannel(groupId, channel)}
      />
    );

    const voiceRoom = (groupId: string, channelId: string, inSplit: boolean) => (
      <VoiceRoom
        key={`${active.id}:${channelId}`}
        groupId={groupId}
        channelId={channelId}
        showBack={!inSplit}
        onBack={() => go(`#/g/${groupId}`)}
        menu={common.menu}
        notice={notice}
        onNoticeClose={common.onNoticeClose}
      />
    );

    const posts = (groupId: string, parentId: string) => (
      <Posts
        key={`${active.id}:${parentId}`}
        parentId={parentId}
        showBack
        menu={common.menu}
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
      if (route.view === "voice") return voiceRoom(route.groupId, route.channelId, false);
      if (route.view === "posts") return posts(route.groupId, route.parentId);
      if (route.view === "thread") return chatRoom(route.groupId, route.threadId, false, route.parentId);
      if (route.view === "channels") return channelList(route.groupId);
      return groupList();
    };
    if (!wide) return single();

    // 넓은 화면: 접고 펴는 버튼은 오른쪽 화면 머리 줄 맨 앞, 계정 메뉴는 오른쪽 위에 늘 같은 자리.
    // 왼쪽 목록은 접어도 자리(aside)는 남겨 두고 폭만 줄여서 부드럽게 여닫는다
    const split = { open: listOpen, toggle: () => setListOpen(!listOpen) };
    // 왼쪽 목록: 둘러보는 중이면 그 서버, 아니면 주소의 서버
    const routeGroup = route.view === "groups" ? null : route.groupId;
    const leftGroup = browse && browse.from === route ? browse.groupId : routeGroup;
    const routeActive =
      route.view === "chat" || route.view === "voice"
        ? route.channelId
        : route.view === "posts" || route.view === "thread"
          ? route.parentId
          : undefined;
    return (
      <div className="split">
        <aside
          className={listOpen ? "split-list" : listPresence.closing ? "split-list split-list-closed" : "split-list split-list-closed split-list-gone"}
          aria-hidden={!listOpen}
          inert={!listOpen}
        >
          {listPresence.shown && (
            <div className="split-list-inner">
              {leftGroup === null
                ? groupList(true)
                : channelList(leftGroup, leftGroup === routeGroup ? routeActive : undefined, true)}
            </div>
          )}
        </aside>
        <SplitContext.Provider value={split}>
          <main className="split-main">
            {!listOpen ? (
              single()
            ) : route.view === "chat" ? (
              chatRoom(route.groupId, route.channelId, true)
            ) : route.view === "voice" ? (
              voiceRoom(route.groupId, route.channelId, true)
            ) : route.view === "posts" ? (
              posts(route.groupId, route.parentId)
            ) : route.view === "thread" ? (
              chatRoom(route.groupId, route.threadId, true, route.parentId)
            ) : (
              <div className="room">
                <header className="room-header">
                  <SplitToggle />
                  <div className="room-title" />
                  {common.menu}
                </header>
                {notice && (
                  <div className="room-notice" role="status">
                    <span>{notice}</span>
                    <button type="button" className="text-button" onClick={common.onNoticeClose} aria-label="안내 닫기">
                      닫기
                    </button>
                  </div>
                )}
                <div className="split-empty">왼쪽에서 {leftGroup === null ? "서버를" : "채널을"} 골라 주세요.</div>
              </div>
            )}
          </main>
        </SplitContext.Provider>
      </div>
    );
  };
  return (
    <LookContext.Provider value={lookValue}>
      <NotifyPrefsContext.Provider value={notifyPrefsValue}>
      {look.theme === "word" ? (
        <div className="word-app">
          <WordChrome />
          <div className="word-stage">{screen()}</div>
        </div>
      ) : (
        screen()
      )}
      {guidePresence.shown && (
        <Guide settings={look} wide={wide} onClose={closeGuide} closing={guidePresence.closing} />
      )}
      {installPresence.shown && <InstallDialog onClose={closeInstall} closing={installPresence.closing} />}
      <NotifyToast toast={notify.toast} onOpen={go} onClose={notify.closeToast} />
      </NotifyPrefsContext.Provider>
    </LookContext.Provider>
  );
}

/** 위장 화면에 쓸 표: 고른 템플릿(날짜는 오늘 기준) 또는 불러온 내 파일 */
function pickWorkbook(
  template: BossTemplate,
  day: string,
  sheet: StoredFile | null,
): { workbook: Workbook; storageKey: string } {
  void day; // 날짜가 바뀌면 템플릿 날짜도 새로
  if (template === "myfile") {
    const file = sheet ?? loadMyFile();
    if (file) return { workbook: file, storageKey: `mos.boss.edits.v1.myfile.${file.stamp}` };
  }
  const id: TemplateId = template === "weekly" || template === "sales" || template === "schedule" || template === "budget"
    ? template
    : "weekly";
  return { workbook: buildTemplate(id), storageKey: `mos.boss.edits.v1.${id}` };
}

interface BossFilesState {
  sheet: StoredFile | null;
  image: { url: string; name: string } | null;
  text: { name: string; body: string } | null;
  note: { name: string; body: string } | null;
  word: { name: string; body: string } | null;
}

const EMPTY_FILES: BossFilesState = { sheet: null, image: null, text: null, note: null, word: null };

/** 계정에 저장된 위장 파일을 받는다(잠겨 있어 못 받으면 이 브라우저에 보관된 것). 예전에 이 브라우저에만 있던 표 파일은 계정으로 옮긴다 */
async function loadBossFiles(): Promise<BossFilesState> {
  let info: AssetList;
  let online = true;
  try {
    info = await fetchBossInfo();
  } catch {
    info = cachedInfo();
    online = false;
  }
  const result: BossFilesState = { ...EMPTY_FILES };
  const sheetInfo = info.sheet;
  if (sheetInfo) {
    try {
      const value = JSON.parse(await (await loadAsset("sheet", sheetInfo)).text()) as Workbook;
      result.sheet = { ...value, stamp: sheetInfo.version };
    } catch {
      // 못 받으면 아래 이 브라우저 것
    }
  } else if (online) {
    const local = loadMyFile();
    if (local) {
      try {
        await uploadAsset("sheet", local.fileName, JSON.stringify(local));
      } catch {
        // 다음에 다시
      }
    }
  }
  const imageInfo = info.image;
  if (imageInfo) {
    try {
      result.image = { url: URL.createObjectURL(await loadAsset("image", imageInfo)), name: imageInfo.name };
    } catch {
      // 없으면 안내 화면
    }
  }
  for (const kind of ["text", "note", "word"] as const) {
    const found = info[kind];
    if (!found) continue;
    try {
      result[kind] = { name: found.name, body: await (await loadAsset(kind, found)).text() };
    } catch {
      // 없으면 예시나 빈 문서
    }
  }
  return result;
}

/** 화면 맨 위: 평소 화면 + 위장 화면(SCR-12). 위장 화면은 미리 그려 두고 숨겼다 보였다만 한다 */
export default function App() {
  const [look, setLook] = useState<Settings>(cachedLook);
  const [bossOn, setBossOn] = useState(false);
  const [fileVersion, setFileVersion] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [accountKey, setAccountKey] = useState<string | undefined>(undefined);
  const [files, setFiles] = useState<BossFilesState>(EMPTY_FILES);
  const day = new Date().toDateString();
  const mode = look.boss_template;

  // 위장 파일: 처음, 계정이 열리거나 바뀔 때, 설정에서 새로 올렸을 때
  useEffect(() => {
    let stopped = false;
    let made: string | null = null;
    void loadBossFiles().then((loaded) => {
      if (stopped) {
        if (loaded.image) URL.revokeObjectURL(loaded.image.url);
        return;
      }
      made = loaded.image?.url ?? null;
      setFiles(loaded);
    });
    return () => {
      stopped = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [accountKey, fileVersion]);

  const { workbook, storageKey } = useMemo(
    () => pickWorkbook(mode, day, files.sheet),
    [mode, day, files.sheet, fileVersion], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // 노션, Word, 메모장 위장 화면의 처음 글과 이름(예시 또는 올린 파일)
  const doc = useMemo(() => {
    const strip = (name: string) => name.replace(/\.[^.]+$/, "");
    if (mode === "memo") return { body: memoExample(), name: "업무 메모" };
    if (mode === "text") return { body: files.text?.body ?? "", name: strip(files.text?.name ?? "제목 없음") };
    if (mode === "note") return { body: noteExample(), name: "업무 정리" };
    if (mode === "notefile") {
      const body = files.note?.body ?? noteExample();
      return { body, name: docTitle(body, strip(files.note?.name ?? "업무 정리")) };
    }
    if (mode === "word") return { body: wordExample(), name: "주간 업무 보고.docx" };
    if (mode === "wordfile") return { body: files.word?.body ?? wordExample(), name: files.word?.name ?? "주간 업무 보고.docx" };
    return null;
  }, [mode, files.text, files.note, files.word, day]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setDisguised(bossOn);
    if (!bossOn) applyLook(look);
    else if (mode === "memo" || mode === "text") applyDisguise(`${doc?.name ?? "제목 없음"} - 메모장`, "memo");
    else if (mode === "note" || mode === "notefile") applyDisguise(doc?.name ?? "업무 정리", "note");
    else if (mode === "word" || mode === "wordfile") applyDisguise(doc?.name ?? "문서.docx", "word");
    else if (mode === "image") applyLook(look); // 사진은 평소 탭 제목 그대로(그 화면을 찍은 것이므로)
    else applyDisguise(workbook.fileName);
  }, [bossOn, look, mode, workbook.fileName, doc?.name]);

  const relock = look.boss_relock;
  const fullscreen = look.boss_fullscreen;
  const bossUrl = look.boss_url;
  const enteredFullscreen = useRef(false);
  const toggle = useCallback(
    (on?: boolean) => {
      if ((on ?? true) && mode === "url" && bossUrl && !isDisguised()) {
        window.location.assign(bossUrl); // 다른 사이트로 바로 이동(돌아오려면 뒤로 가기)
        return;
      }
      setBossOn((current) => {
        const next = on ?? !current;
        if (next && !current && fullscreen && !document.fullscreenElement) {
          // 보스키·모서리 누름 직후라 브라우저가 허락한다(자동 위장 때는 안 될 수 있음)
          document.documentElement
            .requestFullscreen?.()
            .then(() => {
              enteredFullscreen.current = true;
            })
            .catch(() => {});
        }
        if (current && !next && enteredFullscreen.current && document.fullscreenElement) {
          enteredFullscreen.current = false;
          void document.exitFullscreen().catch(() => {});
        }
        if (current && !next && relock) {
          // 돌아올 때 잠그기: 잠그고 잠금 화면으로
          void lock()
            .catch(() => {})
            .finally(() => setRefreshKey((key) => key + 1));
        }
        return next;
      });
    },
    [relock, fullscreen, mode, bossUrl],
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
          onAccountOpen={setAccountKey}
        />
      </div>
      <div className="boss-layer" hidden={!bossOn}>
        {mode === "image" ? (
          <ImageDisguise url={files.image?.url ?? null} fit={look.boss_fit} />
        ) : (mode === "memo" || mode === "text") && doc ? (
          <TextDisguise key={`${mode}:${fileVersion}`} original={doc.body} active={bossOn} editKey={EDIT_KEYS[mode]} />
        ) : (mode === "note" || mode === "notefile") && doc ? (
          <NoteDisguise key={`${mode}:${fileVersion}`} original={doc.body} editKey={EDIT_KEYS[mode]} fallbackTitle={doc.name} />
        ) : (mode === "word" || mode === "wordfile") && doc ? (
          <WordDisguise key={`${mode}:${fileVersion}`} original={doc.body} editKey={EDIT_KEYS[mode]} name={doc.name} />
        ) : (
          <BossScreen key={fileVersion} workbook={workbook} storageKey={storageKey} active={bossOn} />
        )}
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

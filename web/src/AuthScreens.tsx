import { type FormEvent, type ReactNode, useState } from "react";
import { ApiError, removeAccount, setPassword, startConnect, switchAccount, unlock } from "./api";
import { authText } from "./authText";
import { isDiscordMediaUrl, viaServer } from "./format";
import { externalOpenUrl, inAppBrowser, platform } from "./appInstall";
import { cachedLook, lookTitle } from "./theme";
import type { SessionAccount, SessionState } from "./types";

function errorText(caught: unknown): string {
  if (caught instanceof ApiError) {
    if (caught.status === 403 && caught.code === "forbidden") return authText("forbidden");
    return authText(caught.code, caught.retryAfter);
  }
  return "서버에 연결할 수 없어요.";
}

function AccountFace({ account, size = 40 }: { account: SessionAccount; size?: number }) {
  const style = { width: size, height: size };
  if (isDiscordMediaUrl(account.avatar_url)) {
    return <img className="avatar" style={style} src={viaServer(account.avatar_url)} alt="" referrerPolicy="no-referrer" />;
  }
  return (
    <div className="avatar avatar-fallback" style={style}>
      {account.name.slice(0, 1)}
    </div>
  );
}

function Card({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="login-page">
      <div className="login-box">
        <h1>{title}</h1>
        {hint && <p className="login-hint">{hint}</p>}
        {children}
      </div>
    </div>
  );
}

/** 이 브라우저에 계정이 하나도 없을 때 */
/** 카카오톡 같은 앱 안의 브라우저: 로그인이 막히거나 유지되지 않을 수 있어 바깥 브라우저를 권한다 */
function InAppNotice() {
  const [closed, setClosed] = useState(false);
  const app = inAppBrowser();
  if (!app || closed) return null;
  const url = externalOpenUrl(app);
  // 받침에 따라 '로'와 '으로'가 달라서 통째로
  const toBrowser = platform() === "ios" ? "사파리로" : "크롬으로";
  return (
    <div className="inapp-notice" role="status">
      <span>
        {app.name} 안에서는 로그인이 잘 안 될 수 있어요. {toBrowser} 열어 주세요.
        {!url && " (메뉴 › 다른 브라우저로 열기)"}
      </span>
      {url && (
        <a className="inapp-open" href={url}>
          {toBrowser} 열기
        </a>
      )}
      <button type="button" className="text-button" onClick={() => setClosed(true)} aria-label="안내 닫기">
        닫기
      </button>
    </div>
  );
}

export function ConnectScreen({ notice }: { notice: string }) {
  return (
    <Card title={lookTitle()} hint="처음 쓰는 브라우저예요. 계정을 연결해 주세요.">
      <InAppNotice />
      {notice && <p className="login-error">{notice}</p>}
      <button type="button" className="primary-button" onClick={() => startConnect("connect")}>
        계정 연결하기
      </button>
    </Card>
  );
}

/** 연결 직후 5분 안에 앱 비밀번호 정하기(처음 또는 재설정) */
export function PasswordSetup({ account, onDone }: { account: SessionAccount; onDone: () => void }) {
  const [password, setPasswordValue] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (password !== confirm) {
      setError("두 비밀번호가 달라요.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await setPassword(password);
      setPasswordValue("");
      setConfirm("");
      onDone();
    } catch (caught) {
      setError(errorText(caught));
      if (caught instanceof ApiError && caught.code === "setup_expired") onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={account.password_set ? "비밀번호 다시 정하기" : "비밀번호 정하기"}
      hint="이 화면에 들어올 때 쓸 비밀번호예요. 8자 이상, 다른 곳에서 쓰지 않는 것으로 정해 주세요."
    >
      <div className="account-row">
        <AccountFace account={account} />
        <strong>{account.name}</strong>
      </div>
      <form className="login-form" onSubmit={submit}>
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPasswordValue(event.target.value)}
          aria-label="새 비밀번호"
          placeholder="새 비밀번호"
          maxLength={128}
          autoFocus
        />
        <input
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          aria-label="새 비밀번호 확인"
          placeholder="한 번 더"
          maxLength={128}
        />
        {error && <p className="login-error">{error}</p>}
        <button type="submit" className="primary-button" disabled={!password || !confirm || busy}>
          {busy ? "저장 중…" : "정하기"}
        </button>
      </form>
    </Card>
  );
}

/** 비밀번호를 정할 시간이 지났거나 연결이 끊긴 계정 */
export function ReconnectScreen({
  account,
  notice,
  onChanged,
}: {
  account: SessionAccount;
  notice: string;
  onChanged: () => void;
}) {
  const [error, setError] = useState("");
  const forget = async () => {
    try {
      await removeAccount(account.id);
      onChanged();
    } catch (caught) {
      setError(errorText(caught));
    }
  };
  return (
    <Card
      title="다시 연결이 필요해요"
      hint={
        account.disconnected
          ? "연결이 끊긴 계정이에요. 다시 연결해 주세요."
          : "비밀번호를 정하지 않은 계정이에요. 다시 연결한 뒤 5분 안에 정해 주세요."
      }
    >
      <div className="account-row">
        <AccountFace account={account} />
        <strong>{account.name}</strong>
      </div>
      {(notice || error) && <p className="login-error">{error || notice}</p>}
      <button type="button" className="primary-button" onClick={() => startConnect("connect")}>
        다시 연결하기
      </button>
      <button type="button" className="text-button" onClick={forget}>
        이 브라우저에서 이 계정 빼기
      </button>
    </Card>
  );
}

/** 잠긴 계정 열기. 다른 저장된 계정으로 바꾸거나 계정을 더할 수 있다 */
export function UnlockScreen({
  session,
  account,
  notice,
  onChanged,
}: {
  session: SessionState;
  account: SessionAccount;
  notice: string;
  onChanged: () => void;
}) {
  const [password, setPasswordValue] = useState("");
  const [keep, setKeep] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const others = session.accounts.filter((item) => item.id !== account.id);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
      onChanged();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!password) return;
    void run(async () => {
      await unlock(account.id, password, keep);
      setPasswordValue("");
    });
  };

  const canAdd = session.accounts.length < session.max_accounts;
  const theme = cachedLook().theme;
  const title = lookTitle();
  const disguised = theme === "sheet" || theme === "word" || theme === "memo" || theme === "note";
  const words = LOCK_WORDS[disguised ? theme : "moon"];

  const confirmBlock = (
    // 되돌릴 수 없는 일: 설명과 [취소] [빼기]를 나란히
    <div className="login-confirm" role="alert">
      <p>
        이 브라우저에서 {account.name} 계정을 빼요. 다시 쓰려면 디스코드로 다시 연결하고 비밀번호를 새로 정해야
        해요.
      </p>
      <div className="login-confirm-buttons">
        <button type="button" className="pill-button" onClick={() => setConfirmRemove(false)}>
          취소
        </button>
        <button
          type="button"
          className="pill-button pill-button-danger"
          disabled={busy}
          onClick={() => void run(() => removeAccount(account.id))}
        >
          빼기
        </button>
      </div>
    </div>
  );

  const footBlock = (
    <div className="login-foot">
      {canAdd ? (
        <button type="button" className="text-button" onClick={() => startConnect("add")}>
          다른 계정 추가
        </button>
      ) : (
        <span />
      )}
      <button type="button" className="text-button login-remove" onClick={() => setConfirmRemove(true)}>
        이 브라우저에서 빼기
      </button>
    </div>
  );

  const othersBlock = others.length > 0 && (
    <div className="other-accounts">
      <p className="login-hint">이 브라우저의 다른 계정</p>
      {others.map((item) => (
        <button
          key={item.id}
          type="button"
          className="account-pick"
          onClick={() => void run(() => switchAccount(item.id))}
        >
          <AccountFace account={item} size={28} />
          <span>{item.name}</span>
          <span className="account-state">{item.locked ? "잠김" : "열림"}</span>
        </button>
      ))}
    </div>
  );

  const passwordInput = (
    <input
      type="password"
      autoComplete="current-password"
      value={password}
      onChange={(event) => setPasswordValue(event.target.value)}
      aria-label={words.password}
      placeholder={disguised ? undefined : "비밀번호"}
      maxLength={128}
      autoFocus
    />
  );

  const keepBox = (
    <label className="check-row">
      <input type="checkbox" checked={keep} onChange={(event) => setKeep(event.target.checked)} />
      {words.keep}
    </label>
  );

  const errorLine = (error || notice) && <p className="login-error">{error || notice}</p>;

  const forgotButton = (
    <button type="button" className="text-button login-forgot" onClick={() => startConnect("reset")}>
      {words.forgot}
    </button>
  );

  const submitButton = (
    <button type="submit" className="primary-button" disabled={!password || busy}>
      {busy ? "확인 중…" : words.submit}
    </button>
  );

  if (disguised) {
    // 위장 테마: 그 프로그램의 '암호' 창이나 잠긴 페이지 모양(뒤 화면에는 대화 내용을 그리지 않는다)
    return (
      <LockFrame theme={theme} title={title}>
        {words.heading && <h1 className="lock-dialog-title">{words.heading}</h1>}
        <div className="lock-dialog-body">
          <p className="lock-message">{words.message(title)}</p>
          <div className="lock-user">
            {words.userPrefix && <span>{words.userPrefix}</span>}
            <AccountFace account={account} size={words.faceSize} />
            <strong>{account.name}</strong>
            {words.userNote && <span className="lock-user-note">{words.userNote}</span>}
          </div>
          <form className="lock-form" onSubmit={submit}>
            <label className="lock-field">
              <span>{words.password}</span>
              {passwordInput}
            </label>
            {keepBox}
            {errorLine}
            <div className="lock-actions">
              {forgotButton}
              {submitButton}
            </div>
          </form>
        </div>
        <div className="lock-dialog-foot">{confirmRemove ? confirmBlock : footBlock}</div>
        {othersBlock}
      </LockFrame>
    );
  }

  return (
    <Card title={title}>
      <div className="account-row">
        <AccountFace account={account} size={36} />
        <strong>{account.name}</strong>
      </div>
      <form className="login-form" onSubmit={submit}>
        {passwordInput}
        {keepBox}
        {errorLine}
        {submitButton}
        {forgotButton}
      </form>
      {confirmRemove ? confirmBlock : footBlock}
      {othersBlock}
    </Card>
  );
}

type DisguisedTheme = "sheet" | "word" | "memo" | "note";

interface LockWords {
  heading: string;
  message: (title: string) => string;
  userPrefix?: string;
  userNote?: string;
  faceSize: number;
  password: string;
  keep: string;
  submit: string;
  forgot: string;
}

// 테마마다 그 프로그램에서 쓸 법한 말로(하는 일은 모두 같다)
const LOCK_WORDS: Record<DisguisedTheme | "moon", LockWords> = {
  moon: {
    heading: "",
    message: () => "",
    faceSize: 36,
    password: "비밀번호",
    keep: "로그인 유지(30일, 내 기기에서만)",
    submit: "열기",
    forgot: "비밀번호를 잊었어요",
  },
  sheet: {
    heading: "암호",
    message: (title) => `'${title}'은(는) 보호되어 있습니다.`,
    userPrefix: "사용자:",
    faceSize: 20,
    password: "암호(P):",
    keep: "이 기기에서 30일 동안 다시 묻지 않기",
    submit: "확인",
    forgot: "암호를 잊었어요",
  },
  word: {
    heading: "문서 보호 해제",
    message: () => "이 문서는 편집이 제한되어 있어요. 계속하려면 암호를 입력하세요.",
    userNote: "공동 작성자",
    faceSize: 28,
    password: "암호",
    keep: "이 기기에서 30일 동안 묻지 않기",
    submit: "확인",
    forgot: "암호를 잊었어요",
  },
  memo: {
    heading: "암호 입력",
    message: () => "이 파일을 열려면 암호가 필요합니다.",
    faceSize: 22,
    password: "암호",
    keep: "이 기기에서 30일 동안 기억",
    submit: "확인",
    forgot: "암호를 잊었어요",
  },
  note: {
    heading: "",
    message: () => "이 페이지는 잠겨 있어요. 계속 보려면 비밀번호를 입력하세요.",
    userNote: "편집 권한",
    faceSize: 24,
    password: "비밀번호",
    keep: "이 기기에서 30일 동안 잠그지 않기",
    submit: "열기",
    forgot: "비밀번호를 잊었어요",
  },
};

const SHEET_TABS = ["파일", "홈", "삽입", "페이지 레이아웃", "수식", "데이터", "검토", "보기"];
const WORD_TABS = ["파일", "홈", "삽입", "디자인", "레이아웃", "참조", "검토", "보기"];
const MEMO_MENU = ["파일", "편집", "서식", "보기", "도움말"];

/** 잠금 화면의 테마별 틀: 위 제목 줄, 뒤 화면(장식), 가운데 창, 아래 상태 줄 */
function LockFrame({ theme, title, children }: { theme: DisguisedTheme; title: string; children: ReactNode }) {
  const memoTitle = title.endsWith(" - 메모장") ? title : `${title} - 메모장`;
  return (
    <div className={`lock-shell lock-${theme}`}>
      {theme === "sheet" && (
        <div className="lock-chrome" aria-hidden="true">
          <div className="lock-titlebar">
            <span className="lock-app-mark">▦</span>
            <span>{title}</span>
            <span className="lock-dim">읽기 전용</span>
          </div>
          <div className="lock-tabs">
            {SHEET_TABS.map((tab) => (
              <span key={tab} className={tab === "홈" ? "lock-tab-on" : undefined}>
                {tab}
              </span>
            ))}
          </div>
          <div className="lock-ribbon" />
          <div className="lock-formula">
            <span className="lock-namebox">A1</span>
            <span className="lock-fx">fx</span>
            <span className="lock-formula-input" />
          </div>
        </div>
      )}
      {theme === "word" && (
        <div className="lock-chrome" aria-hidden="true">
          <div className="lock-titlebar">
            <strong>Word</strong>
            <span>{title}</span>
            <span className="lock-dim">읽기 전용</span>
          </div>
          <div className="lock-tabs">
            {WORD_TABS.map((tab) => (
              <span key={tab} className={tab === "홈" ? "lock-tab-on" : undefined}>
                {tab}
              </span>
            ))}
          </div>
          <div className="lock-ribbon" />
        </div>
      )}
      {theme === "memo" && (
        <div className="lock-chrome" aria-hidden="true">
          <div className="lock-titlebar">
            <span>{memoTitle}</span>
          </div>
          <div className="lock-tabs">
            {MEMO_MENU.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
        </div>
      )}
      {theme === "note" && (
        <div className="lock-chrome" aria-hidden="true">
          <div className="lock-titlebar">
            <strong className="lock-note-ws">업무 공간</strong>
            <span className="lock-dim">업무 공간 /</span>
            <span>{title}</span>
            <span className="lock-spacer" />
            <span className="lock-dim">잠김</span>
          </div>
        </div>
      )}
      <div className="lock-stage">
        {/* 뒤 화면: 빈 시트, 빈 종이, 빈 메모장, 노션 사이드바. 대화 내용은 그리지 않는다 */}
        <div className="lock-backdrop" aria-hidden="true">
          {theme === "word" && <div className="lock-paper" />}
          {theme === "memo" && <span className="lock-caret" />}
          {theme === "note" && (
            <div className="lock-sidebar">
              <span>팀스페이스</span>
              {[90, 110, 70, 100, 80].map((width) => (
                <i key={width} style={{ width }} />
              ))}
            </div>
          )}
        </div>
        <main className="lock-dialog">
          {theme === "note" && (
            <>
              <svg className="lock-note-icon" viewBox="0 0 24 24" aria-hidden="true">
                <rect x="5" y="11" width="14" height="10" rx="2" />
                <path d="M8 11V8a4 4 0 0 1 8 0v3" />
              </svg>
              <h1 className="lock-note-title">{title}</h1>
            </>
          )}
          {children}
        </main>
      </div>
      {theme === "sheet" && (
        <div className="lock-status" aria-hidden="true">
          <span>암호 입력 대기</span>
          <span>100%</span>
        </div>
      )}
      {theme === "word" && (
        <div className="lock-status" aria-hidden="true">
          <span>1/1페이지 &nbsp; 편집 제한됨</span>
          <span>100%</span>
        </div>
      )}
      {theme === "memo" && (
        <div className="lock-status" aria-hidden="true">
          <span>줄 1, 열 1</span>
          <span className="lock-wide">100%</span>
          <span className="lock-wide">Windows (CRLF)</span>
          <span className="lock-wide">UTF-8</span>
        </div>
      )}
    </div>
  );
}

export { AccountFace };

import { type FormEvent, type ReactNode, useState } from "react";
import { ApiError, removeAccount, setPassword, startConnect, switchAccount, unlock } from "./api";
import { authText } from "./authText";
import { isDiscordMediaUrl, viaServer } from "./format";
import { externalOpenUrl, inAppBrowser, platform } from "./appInstall";
import { lookTitle } from "./theme";
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

  return (
    <Card title={lookTitle()}>
      <div className="account-row">
        <AccountFace account={account} />
        <strong>{account.name}</strong>
      </div>
      <form className="login-form" onSubmit={submit}>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPasswordValue(event.target.value)}
          aria-label="비밀번호"
          placeholder="비밀번호"
          maxLength={128}
          autoFocus
        />
        <label className="check-row">
          <input type="checkbox" checked={keep} onChange={(event) => setKeep(event.target.checked)} />
          로그인 유지(30일, 내 기기에서만)
        </label>
        {(error || notice) && <p className="login-error">{error || notice}</p>}
        <button type="submit" className="primary-button" disabled={!password || busy}>
          {busy ? "확인 중…" : "열기"}
        </button>
      </form>

      <div className="login-links">
        <button type="button" className="text-button" onClick={() => startConnect("reset")}>
          비밀번호를 잊었어요
        </button>
        {session.accounts.length < session.max_accounts && (
          <button type="button" className="text-button" onClick={() => startConnect("add")}>
            다른 계정 추가
          </button>
        )}
        <button type="button" className="text-button" onClick={() => void run(() => removeAccount(account.id))}>
          이 브라우저에서 빼기
        </button>
      </div>

      {others.length > 0 && (
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
      )}
    </Card>
  );
}

export { AccountFace };

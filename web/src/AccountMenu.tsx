import { usePresence } from "./motion";
import { useEffect, useRef, useState } from "react";
import { lock, logout, removeAccount, setNitroClaim, startConnect, switchAccount } from "./api";
import { disablePush } from "./webPush";
import { AccountFace } from "./AuthScreens";
import type { SessionAccount, SessionState } from "./types";

interface Props {
  session: SessionState;
  account: SessionAccount;
  onChanged: () => void;
  onOpenSettings: () => void;
  onOpenGuide: () => void;
  onOpenInstall: () => void;
  /** TODO를 쓸 수 있는 계정이면: 어느 화면에서든 TODO로 바로(2026-11-23 사용자 요청) */
  onOpenTodo?: () => void;
  /** TODO 위젯(안드로이드 APK) 받기 창. TODO 계정, 아이폰이 아닐 때만 */
  onOpenWidgetApk?: () => void;
}

function nitroText(account: SessionAccount): string {
  if (account.nitro === "verified" && account.nitro_until) {
    const until = new Date(account.nitro_until * 1000);
    return `확인됨 (${until.getMonth() + 1}/${until.getDate()}까지)`;
  }
  if (account.nitro === "pending") return "확인 기다리는 중";
  return "";
}

/** 니트로 인증 방법 안내(메뉴 안 작은 글씨) */
function nitroHelp(account: SessionAccount): string {
  if (account.nitro === "verified") return "니트로 이모지를 쓸 때마다 7일씩 갱신돼요.";
  if (account.nitro === "pending") {
    return "디스코드 앱에서 움직이는 이모지나 다른 서버 이모지를 메시지나 반응으로 한 번 쓰면 확인돼요.";
  }
  return "니트로가 있으면 켜 주세요. 켠 뒤 디스코드 앱에서 니트로 이모지를 한 번 쓰면 확인돼요.";
}

/** 채팅방 오른쪽 위: 잠그기, 니트로, 계정 바꾸기·추가·빼기 */
export default function AccountMenu({
  session,
  account,
  onChanged,
  onOpenSettings,
  onOpenGuide,
  onOpenInstall,
  onOpenTodo,
  onOpenWidgetApk,
}: Props) {
  const [open, setOpen] = useState(false);
  const presence = usePresence(open, 150);
  const [askRemove, setAskRemove] = useState(false);
  const [askLogout, setAskLogout] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const others = session.accounts.filter((item) => item.id !== account.id);

  useEffect(() => {
    if (!open) {
      // 메뉴를 닫으면 묻던 것도 취소
      setAskRemove(false);
      setAskLogout(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !boxRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  // 로그아웃: 서버에서 이 브라우저의 계정을 모두 빼고, 이 브라우저에 남은 사본(설정, 위장 파일, 알림 구독)도 지운 뒤 처음 화면으로
  const signOut = async () => {
    setLoggingOut(true);
    try {
      await disablePush().catch(() => "off");
      await logout();
      try {
        const keys: string[] = [];
        for (let index = 0; index < window.localStorage.length; index += 1) {
          const key = window.localStorage.key(index);
          if (key?.startsWith("mos.")) keys.push(key);
        }
        for (const key of keys) window.localStorage.removeItem(key);
        if ("caches" in window) await caches.delete("mos-boss-v1");
      } catch {
        // 지우지 못한 사본은 다음 로그인 때 덮어쓴다
      }
      window.location.replace("/");
    } catch {
      setLoggingOut(false);
      onChanged();
    }
  };

  const run = async (action: () => Promise<void>) => {
    setOpen(false);
    try {
      await action();
    } finally {
      onChanged();
    }
  };

  return (
    <div className="account-menu" ref={boxRef}>
      <button
        type="button"
        className="account-menu-button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={account.name}
      >
        <AccountFace account={account} size={28} />
      </button>
      {presence.shown && (
        <div className={presence.closing ? "account-menu-list pop-out" : "account-menu-list"} role="menu" inert={presence.closing}>
          <div className="account-menu-head">
            <strong>{account.name}</strong>
            {account.kept && <span className="account-state">로그인 유지 중</span>}
          </div>
          {onOpenTodo && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onOpenTodo();
              }}
            >
              TODO
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
          >
            설정
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenGuide();
            }}
          >
            사용 방법
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenInstall();
            }}
          >
            앱으로 설치
          </button>
          {onOpenWidgetApk && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onOpenWidgetApk();
              }}
            >
              TODO 위젯 받기(안드로이드)
            </button>
          )}
          <button type="button" role="menuitem" onClick={() => void run(lock)}>
            잠그기
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            className="menu-toggle"
            aria-checked={account.nitro !== "none"}
            onClick={() => void run(() => setNitroClaim(account.nitro === "none"))}
          >
            <span className="menu-toggle-text">
              <span className="menu-toggle-title">
                니트로 있어요
                {nitroText(account) && <span className="account-state">{nitroText(account)}</span>}
              </span>
              <span className="menu-help">{nitroHelp(account)}</span>
            </span>
            <span className={account.nitro !== "none" ? "switch-look switch-look-on" : "switch-look"} aria-hidden="true" />
          </button>
          <div className="menu-divider" role="separator" />
          {session.accounts.length < session.max_accounts && (
            <button type="button" role="menuitem" onClick={() => startConnect("add")}>
              다른 계정 추가
            </button>
          )}
          {session.accounts.length > 1 &&
            (askRemove ? (
              // 되돌리려면 디스코드로 다시 연결해야 하니 한 번 묻는다(빼기와 취소를 나란히)
              <div className="menu-confirm" role="alertdialog" aria-label="계정 빼기 확인">
                <p>이 브라우저에서 '{account.name}' 계정을 뺄까요? 다시 쓰려면 디스코드로 다시 연결해야 해요.</p>
                <div className="menu-confirm-buttons">
                  <button type="button" className="danger" onClick={() => void run(() => removeAccount(account.id))}>
                    빼기
                  </button>
                  <button type="button" onClick={() => setAskRemove(false)} autoFocus>
                    취소
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAskLogout(false);
                  setAskRemove(true);
                }}
              >
                이 브라우저에서 이 계정 빼기
              </button>
            ))}
          {askLogout ? (
            <div className="menu-confirm" role="alertdialog" aria-label="로그아웃 확인">
              <p>
                {session.accounts.length > 1
                  ? `이 브라우저에 넣어 둔 계정 ${session.accounts.length}개에서 모두 로그아웃할까요?`
                  : "이 브라우저에서 로그아웃할까요?"}{" "}
                다시 쓰려면 디스코드로 다시 연결해야 해요.
              </p>
              <div className="menu-confirm-buttons">
                <button type="button" className="danger" disabled={loggingOut} onClick={() => void signOut()}>
                  {loggingOut ? "나가는 중…" : "로그아웃"}
                </button>
                <button type="button" disabled={loggingOut} onClick={() => setAskLogout(false)} autoFocus>
                  취소
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={() => {
                setAskRemove(false);
                setAskLogout(true);
              }}
            >
              로그아웃
            </button>
          )}
          {others.length > 0 && (
            <>
              <div className="menu-divider" role="separator" />
              <div className="menu-section-title">다른 계정으로 바꾸기</div>
              {others.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  className="menu-account"
                  onClick={() => void run(() => switchAccount(item.id))}
                >
                  <AccountFace account={item} size={24} />
                  <span className="menu-account-name" title={item.name}>
                    {item.name}
                  </span>
                  {item.locked && <span className="account-state">잠김</span>}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

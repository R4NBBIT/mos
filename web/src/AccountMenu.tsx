import { useEffect, useRef, useState } from "react";
import { lock, removeAccount, setNitroClaim, startConnect, switchAccount } from "./api";
import { AccountFace } from "./AuthScreens";
import type { SessionAccount, SessionState } from "./types";

interface Props {
  session: SessionState;
  account: SessionAccount;
  onChanged: () => void;
  onOpenSettings: () => void;
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
export default function AccountMenu({ session, account, onChanged, onOpenSettings }: Props) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const others = session.accounts.filter((item) => item.id !== account.id);

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
      {open && (
        <div className="account-menu-list" role="menu">
          <div className="account-menu-head">
            <strong>{account.name}</strong>
            {account.kept && <span className="account-state">로그인 유지 중</span>}
          </div>
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
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => void run(() => removeAccount(account.id))}
          >
            이 브라우저에서 이 계정 빼기
          </button>
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
                  <span className="menu-account-name">{item.name}</span>
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

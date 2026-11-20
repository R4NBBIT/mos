import { useEffect, useRef, useState } from "react";
import { lock, removeAccount, startConnect, switchAccount } from "./api";
import { AccountFace } from "./AuthScreens";
import type { SessionAccount, SessionState } from "./types";

interface Props {
  session: SessionState;
  account: SessionAccount;
  onChanged: () => void;
}

/** 채팅방 오른쪽 위: 잠그기, 계정 바꾸기·추가·빼기 */
export default function AccountMenu({ session, account, onChanged }: Props) {
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
          <button type="button" role="menuitem" onClick={() => void run(lock)}>
            잠그기
          </button>
          {others.map((item) => (
            <button key={item.id} type="button" role="menuitem" onClick={() => void run(() => switchAccount(item.id))}>
              <AccountFace account={item} size={22} />
              {item.name}로 바꾸기
            </button>
          ))}
          {session.accounts.length < session.max_accounts && (
            <button type="button" role="menuitem" onClick={() => startConnect("connect")}>
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
        </div>
      )}
    </div>
  );
}

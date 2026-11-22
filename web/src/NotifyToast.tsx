// 화면을 보고 있는 중에 다른 채널, 포럼 글에 새 메시지가 오면 잠깐 보이는 작은 알림.
// 누르면 그곳으로 가고, 6초 뒤 저절로 사라진다.
import { useRef } from "react";
import { usePresence } from "./motion";
import type { NotifyToast as Toast } from "./useNotifications";

interface Props {
  toast: Toast | null;
  onOpen: (route: string) => void;
  onClose: () => void;
}

export default function NotifyToast({ toast, onOpen, onClose }: Props) {
  // 사라질 때도 잠깐 남겨 두고 흐려지게
  const last = useRef<Toast | null>(null);
  if (toast) last.current = toast;
  const presence = usePresence(toast !== null);
  const shownToast = toast ?? last.current;
  if (!presence.shown || !shownToast) return null;
  return (
    <div
      className={presence.closing ? "notify-toast notify-toast-out" : "notify-toast"}
      role="status"
      key={shownToast.key}
      inert={presence.closing}
    >
      <button
        type="button"
        className="notify-toast-main"
        onClick={() => {
          onClose();
          onOpen(shownToast.route);
        }}
      >
        <strong className="notify-toast-title">{shownToast.title}</strong>
        {shownToast.body && <span className="notify-toast-body">{shownToast.body}</span>}
      </button>
      <button type="button" className="notify-toast-close" onClick={onClose} aria-label="알림 닫기">
        ×
      </button>
    </div>
  );
}

// 화면을 보고 있는 중에 다른 채널, 포럼 글에 새 메시지가 오면 잠깐 보이는 작은 알림.
// 누르면 그곳으로 가고, 6초 뒤 저절로 사라진다.
import type { NotifyToast as Toast } from "./useNotifications";

interface Props {
  toast: Toast | null;
  onOpen: (route: string) => void;
  onClose: () => void;
}

export default function NotifyToast({ toast, onOpen, onClose }: Props) {
  if (!toast) return null;
  return (
    <div className="notify-toast" role="status" key={toast.key}>
      <button
        type="button"
        className="notify-toast-main"
        onClick={() => {
          onClose();
          onOpen(toast.route);
        }}
      >
        <strong className="notify-toast-title">{toast.title}</strong>
        {toast.body && <span className="notify-toast-body">{toast.body}</span>}
      </button>
      <button type="button" className="notify-toast-close" onClick={onClose} aria-label="알림 닫기">
        ×
      </button>
    </div>
  );
}

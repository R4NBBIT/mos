// 넓은 화면에서 왼쪽 목록을 접고 펴는 버튼. 오른쪽 화면의 머리 줄 맨 앞에 놓인다
// (목록 쪽에는 두지 않아, 접든 펴든 같은 자리의 같은 버튼으로 다시 펼 수 있다).
import { createContext, useContext } from "react";

interface SplitState {
  open: boolean;
  toggle: () => void;
}

export const SplitContext = createContext<SplitState | null>(null);

export default function SplitToggle() {
  const split = useContext(SplitContext);
  if (!split) return null;
  return (
    <button
      type="button"
      className="pane-toggle"
      aria-expanded={split.open}
      aria-label={split.open ? "왼쪽 목록 접기" : "왼쪽 목록 펼치기"}
      title={split.open ? "목록 접기" : "목록 펼치기"}
      onClick={split.toggle}
    >
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
        <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M7.5 3.5v13" stroke="currentColor" strokeWidth="1.5" />
        {split.open && <rect x="3.25" y="4.25" width="3.5" height="11.5" rx="1.5" fill="currentColor" opacity="0.35" />}
      </svg>
    </button>
  );
}

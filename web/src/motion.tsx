// 여닫는 움직임: 펼치고 접기(Collapse), 사라질 때도 잠깐 남겨 두기(usePresence).
// '동작 줄이기'를 켠 사람에게는 움직임 없이 바로 바뀐다(CSS에서도 한 번 더 막는다).
import { type ReactNode, useEffect, useState } from "react";

export const MOTION_MS = 200;

export function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** 닫힌 뒤에도 사라지는 움직임 동안(ms) 남겨 둔다. shown이면 그리고, closing이면 사라지는 중.
 * 닫힌 바로 그 그림부터 closing이어야 해서(한 번이라도 사라졌다 다시 생기면 움직임이 끊긴다)
 * 그리는 도중에 바뀐 것을 알아챈다 */
export function usePresence(open: boolean, ms = MOTION_MS): { shown: boolean; closing: boolean } {
  const [state, setState] = useState({ open, closing: false });
  let closing = state.closing;
  if (state.open !== open) {
    closing = !open && !reducedMotion();
    setState({ open, closing });
  }
  useEffect(() => {
    if (!state.closing) return;
    const timer = window.setTimeout(() => setState((current) => ({ ...current, closing: false })), ms);
    return () => window.clearTimeout(timer);
  }, [state.closing, ms]);
  return { shown: open || closing, closing: !open && closing };
}

/**
 * 높이가 부드럽게 펼쳐지고 접히는 칸. 처음부터 열려 있으면 움직이지 않는다.
 * 닫히는 동안에는 내용을 남겨 두고, 다 닫히면 없앤다.
 */
export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  const { shown } = usePresence(open);
  const [expanded, setExpanded] = useState(open);
  useEffect(() => {
    if (!open) {
      setExpanded(false);
      return;
    }
    // 접힌 모양을 한 번 그린 다음 펼쳐야 움직임이 보인다
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => setExpanded(true));
    });
    return () => {
      window.cancelAnimationFrame(first);
      window.cancelAnimationFrame(second);
    };
  }, [open]);
  if (!shown) return null;
  return (
    <div className={expanded ? "collapse collapse-open" : "collapse"}>
      <div className="collapse-inner">{children}</div>
    </div>
  );
}

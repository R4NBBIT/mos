// 위로 한참 올려 읽고 있을 때 오른쪽 아래에 뜨는 '맨 아래로' 동그라미 단추.
// 새 메시지가 왔으면 단추 위에 수를 단다. 대화 목록 상자 안 오른쪽 아래에 붙도록
// 목록의 화면 위치를 재서 고정 위치로 그린다(테마마다 아래 입력칸 높이가 달라서).
import { type RefObject, useEffect, useState } from "react";
import { createPortal } from "react-dom";

const GAP_PX = 14;

export default function JumpToBottom({
  listRef,
  shown,
  unseen,
  insetRight,
  onClick,
}: {
  listRef: RefObject<HTMLDivElement | null>;
  shown: boolean;
  unseen: number;
  /** 목록 상자 오른쪽 안쪽으로 더 들일 폭(Word: 회색 바탕 말고 흰 종이 안에) */
  insetRight?: (listWidth: number) => number;
  onClick: () => void;
}) {
  const [place, setPlace] = useState<{ right: number; bottom: number } | null>(null);
  useEffect(() => {
    const list = listRef.current;
    if (!shown || !list) return;
    const measure = () => {
      const box = list.getBoundingClientRect();
      const view = window.visualViewport;
      const viewHeight = view ? view.height + view.offsetTop : window.innerHeight;
      const inset = insetRight ? insetRight(box.width) : 0;
      setPlace({
        right: Math.max(GAP_PX, document.documentElement.clientWidth - box.right + inset + GAP_PX),
        bottom: Math.max(GAP_PX, viewHeight - box.bottom + GAP_PX),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [listRef, shown, insetRight]);
  // 위치 계산이 흔들리지 않게 화면 맨 바깥(.app-root, 위장 중에는 통째로 inert)에 그린다
  const host = listRef.current?.closest(".app-root");
  if (!shown || !place || !host) return null;
  const label = unseen > 0 ? `맨 아래로, 새 메시지 ${unseen}개` : "맨 아래로";
  return createPortal(
    <button
      type="button"
      className="jump-bottom"
      style={{ right: place.right, bottom: place.bottom }}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M10 4v11M5 10.5l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {unseen > 0 && <span className="jump-bottom-count">{unseen > 99 ? "99+" : unseen}</span>}
    </button>,
    host,
  );
}

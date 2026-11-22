// 왼쪽 목록 순서 바꾸기(이 사이트에서만, 디스코드에는 그대로).
// 순서는 계정 설정 list_order에 저장돼서 다른 브라우저에서도 같다.
// PC는 마우스로 줄을 바로 끌고, 휴대폰은 '순서 바꾸기'를 눌러 나오는 손잡이를 끈다.
import { type KeyboardEvent, type PointerEvent, type ReactNode, useRef, useState } from "react";
import { useLook } from "./lookContext";
import type { ChannelInfo } from "./types";

const DRAG_START_PX = 6;
const EDGE_SCROLL_PX = 40;

/** 저장된 순서대로. 저장된 순서에 없는 것(새로 생긴 서버, 채널)은 원래 순서대로 뒤에 */
export function applyOrder<T extends { id: string }>(items: T[], order: string[] | undefined): T[] {
  if (!order || order.length === 0) return items;
  const rank = new Map(order.map((id, index) => [id, index]));
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (rank.get(a.item.id) ?? order.length + a.index) - (rank.get(b.item.id) ?? order.length + b.index))
    .map(({ item }) => item);
}

export interface ChannelSection {
  key: string;
  name: string | null;
  channels: ChannelInfo[];
}

/** 디스코드 카테고리별로 묶고, 묶음 안에서는 저장된 순서대로 */
export function channelSections(channels: ChannelInfo[], order?: string[]): ChannelSection[] {
  const sections: ChannelSection[] = [];
  for (const channel of channels) {
    const key = channel.category_id ?? "";
    let section = sections.find((item) => item.key === key);
    if (!section) {
      section = { key, name: channel.category_name, channels: [] };
      sections.push(section);
    }
    section.channels.push(channel);
  }
  return sections.map((section) => ({ ...section, channels: applyOrder(section.channels, order) }));
}

/** 시트 탭처럼 한 줄로 늘어놓을 때도 왼쪽 목록과 같은 순서 */
export function orderedChannels(channels: ChannelInfo[], order?: string[]): ChannelInfo[] {
  return channelSections(channels, order).flatMap((section) => section.channels);
}

function moveTo(ids: string[], id: string, index: number): string[] {
  const rest = ids.filter((item) => item !== id);
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, id);
  return rest;
}

/** 끈 뒤 바로 이어지는 클릭(채널 열기)은 막는다 */
function swallowNextClick() {
  const stop = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
  };
  window.addEventListener("click", stop, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 0);
}

function scrollParent(element: HTMLElement | null): HTMLElement | null {
  let node = element?.parentElement ?? null;
  while (node) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return null;
}

/** 끌어서 순서를 바꾸는 목록. children은 (항목, 손잡이)로 한 줄을 그린다 */
export function Sortable<T extends { id: string }>({
  items,
  editing,
  label,
  onReorder,
  children,
}: {
  items: T[];
  /** 순서 바꾸기 중(손잡이가 보인다) */
  editing: boolean;
  label: (item: T) => string;
  onReorder: (ids: string[]) => void;
  children: (item: T, handle: ReactNode) => ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: string; index: number } | null>(null);
  const ids = items.map((item) => item.id);
  const shownIds = drag ? moveTo(ids, drag.id, drag.index) : ids;
  const byId = new Map(items.map((item) => [item.id, item]));

  const start = (event: PointerEvent, id: string, immediate: boolean) => {
    const box = boxRef.current;
    if (!box) return;
    const startY = event.clientY;
    let active = false;
    let index = ids.indexOf(id);
    const scroller = scrollParent(box);
    const onMove = (move: globalThis.PointerEvent) => {
      if (move.pointerId !== event.pointerId) return;
      if (!active) {
        if (!immediate && Math.abs(move.clientY - startY) < DRAG_START_PX) return;
        active = true;
        document.body.classList.add("sorting");
      }
      move.preventDefault();
      // 끄는 줄을 뺀 나머지 줄 가운데보다 아래에 있으면 그만큼 뒤로
      const rows = Array.from(box.querySelectorAll<HTMLElement>(":scope > [data-sort-id]"));
      index = rows.filter(
        (row) => row.dataset.sortId !== id && row.getBoundingClientRect().top + row.offsetHeight / 2 < move.clientY,
      ).length;
      setDrag({ id, index });
      if (scroller) {
        const rect = scroller.getBoundingClientRect();
        if (move.clientY < rect.top + EDGE_SCROLL_PX) scroller.scrollBy(0, -12);
        else if (move.clientY > rect.bottom - EDGE_SCROLL_PX) scroller.scrollBy(0, 12);
      }
    };
    const onEnd = (end: globalThis.PointerEvent) => {
      if (end.pointerId !== event.pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      document.body.classList.remove("sorting");
      setDrag(null);
      if (!active) return;
      swallowNextClick();
      const next = moveTo(ids, id, index);
      if (end.type === "pointerup" && next.join() !== ids.join()) onReorder(next);
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };

  const nudge = (event: KeyboardEvent, id: string) => {
    const from = ids.indexOf(id);
    const to = event.key === "ArrowUp" ? from - 1 : event.key === "ArrowDown" ? from + 1 : from;
    if (to === from) return;
    event.preventDefault();
    if (to >= 0 && to < ids.length) onReorder(moveTo(ids, id, to));
  };

  return (
    <div className="sortable" ref={boxRef}>
      {shownIds.map((id) => {
        const item = byId.get(id);
        if (!item) return null;
        const handle = editing ? (
          <button
            type="button"
            className="sort-handle"
            aria-label={`${label(item)} 순서 옮기기(위아래 화살표)`}
            title="끌어서 옮기기(이 사이트에서만 바뀌어요)"
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              start(event, id, true);
            }}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => nudge(event, id)}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 5h10M3 8h10M3 11h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        ) : null;
        return (
          <div
            key={id}
            data-sort-id={id}
            className={drag?.id === id ? "sortable-item sortable-dragging" : "sortable-item"}
            onPointerDown={(event) => {
              // PC 마우스는 손잡이 없이 줄을 바로 끈다(누르고 조금 움직여야 시작, 그냥 누르면 열기)
              if (event.pointerType !== "mouse" || event.button !== 0) return;
              if ((event.target as HTMLElement).closest("button, a, input")) return;
              start(event, id, false);
            }}
          >
            {children(item, handle)}
          </div>
        );
      })}
    </div>
  );
}

/** 디스코드 순서로 되돌리기(확인 후). 바꾼 순서가 없으면 누를 수 없다 */
export function ResetOrder({ keys, what, children }: { keys: string[]; what: string; children?: ReactNode }) {
  const { settings, save } = useLook();
  const [confirming, setConfirming] = useState(false);
  const custom = keys.some((key) => (settings.list_order[key] ?? []).length > 0);
  if (confirming) {
    return (
      <div className="confirm-box order-confirm" role="alertdialog" aria-label="순서 되돌리기 확인">
        <span>{what} 순서를 디스코드 순서로 되돌릴까요?</span>
        <div className="confirm-actions">
          <button
            type="button"
            className="danger"
            onClick={() => {
              setConfirming(false);
              void save({ list_order: Object.fromEntries(keys.map((key) => [key, null])) });
            }}
          >
            되돌리기
          </button>
          <button type="button" onClick={() => setConfirming(false)}>
            취소
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="order-actions">
      <button type="button" className="text-button" disabled={!custom} onClick={() => setConfirming(true)}>
        {what} 순서 되돌리기
      </button>
      {children}
    </div>
  );
}

/** 목록 아래: 순서 바꾸기 켜고 끄기, 디스코드 순서로 되돌리기 */
export function OrderBar({
  editing,
  onEditing,
  keys,
  what,
}: {
  editing: boolean;
  onEditing: (editing: boolean) => void;
  /** 이 목록의 순서 키들(되돌리기 대상) */
  keys: string[];
  /** 무엇의 순서인지(서버, 채널) */
  what: string;
}) {
  if (!editing) {
    return (
      <div className="order-bar">
        <button type="button" className="text-button order-toggle" onClick={() => onEditing(true)}>
          순서 바꾸기
        </button>
      </div>
    );
  }
  return (
    // 한 줄만: 되돌리기와 완료(설명은 손잡이에 마우스를 올리면)
    <div className="order-bar order-bar-on">
      <ResetOrder keys={keys} what={what}>
        <button type="button" className="order-done" onClick={() => onEditing(false)}>
          완료
        </button>
      </ResetOrder>
    </div>
  );
}

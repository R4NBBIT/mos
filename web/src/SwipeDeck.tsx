// 휴대폰: 디스코드처럼 옆으로 밀어서 화면 사이를 오간다.
// 단계는 0 서버 목록, 1 채널 목록, 2 채팅(채팅방, 글, 음성). 오른쪽으로 밀면 한 단계 앞(목록)이 손가락을 따라
// 드러나고, 왼쪽으로 밀면 마지막에 보던 다음 단계가 오른쪽에서 따라 들어온다. 3분의 1 넘게(또는 빠르게) 밀면
// 넘어가고, 덜 밀면 제자리로 돌아온다. 위아래 스크롤, 입력칸, 옆으로 스크롤되는 표와 코드는 건드리지 않는다.
// 손가락을 따라가는 동안에는 React로 다시 그리지 않고 transform만 바꾼다(채팅방이 무거워서).
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

const LOCK_PX = 10; // 이만큼 움직이면 가로인지 세로인지 정한다
const GO_RATIO = 0.33; // 화면 폭의 이만큼 넘게 밀면 넘어간다
const FLICK_SPEED = 0.45; // px/ms. 이보다 빠르게 튕기면 짧아도 넘어간다
const UNDER_SHIFT = 0.25; // 아래 화면은 덜 움직여 깊이감(폭의 25%)
const SETTLE_MS = 220;
const LEVELS = [0, 1, 2] as const;

// 여기서 시작한 손가락은 화면 넘기기로 쓰지 않는다
const NO_SWIPE = [
  "input",
  "textarea",
  "select",
  "[contenteditable='true']",
  "[data-no-swipe]",
  "[role='dialog']",
  "dialog",
  ".reaction-picker",
  ".emoji-picker",
  ".drawer",
].join(",");

interface Props {
  /** 지금 화면의 단계 */
  level: number;
  /** 그 단계에 보일 화면(없으면 빈 바탕) */
  render: (level: number) => ReactNode;
  /** 그 단계로 넘어갈 수 있는지(다음 단계는 마지막에 보던 곳이 있을 때만) */
  canGo: (level: number) => boolean;
  /** 넘어가기(주소 바꾸기) */
  onGo: (level: number) => void;
}

interface Gesture {
  startX: number;
  startY: number;
  lastX: number;
  lastT: number;
  speed: number;
  /** null: 아직 방향을 안 정함, false: 이 손가락은 쓰지 않음 */
  target: number | null | false;
  dx: number;
}

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function isIosBrowser(): boolean {
  // 아이폰 사파리는 왼쪽 끝에서 밀면 브라우저가 뒤로 간다(설치한 앱은 아님). 그 자리는 양보한다
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return /iPhone|iPad|iPod/.test(navigator.userAgent) && !standalone;
}

/** 손가락이 가려는 쪽으로 더 스크롤되는 가로 스크롤 상자가 있으면 그 상자에 양보한다 */
export function scrollsSideways(from: Element | null, root: Element, dx: number): boolean {
  for (let node = from; node && node !== root; node = node.parentElement) {
    if (!(node instanceof HTMLElement) || node.scrollWidth <= node.clientWidth + 2) continue;
    const overflow = window.getComputedStyle(node).overflowX;
    if (overflow !== "auto" && overflow !== "scroll") continue;
    if (dx > 0 && node.scrollLeft > 0) return true;
    if (dx < 0 && node.scrollLeft + node.clientWidth < node.scrollWidth - 1) return true;
  }
  return false;
}

export default function SwipeDeck({ level, render, canGo, onGo }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const slotRefs = useRef<(HTMLDivElement | null)[]>([]);
  const shadeRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const settlingRef = useRef(false);
  // 손가락을 따라 드러나는 이웃 화면(그동안만 그린다)
  const [extra, setExtra] = useState<number | null>(null);
  const propsRef = useRef({ level, canGo, onGo });
  propsRef.current = { level, canGo, onGo };

  // 단계가 바뀌면(주소가 바뀌면) 남은 위치를 지운다
  useEffect(() => {
    for (const slot of slotRefs.current) {
      if (!slot) continue;
      slot.style.transform = "";
      slot.style.transition = "";
    }
    if (shadeRef.current) {
      shadeRef.current.style.opacity = "";
      shadeRef.current.style.transition = "";
    }
  }, [level]);

  /** 진행 정도(0~1)에 맞춰 위, 아래 화면과 그늘 위치를 바꾼다 */
  const place = useCallback((target: number, progress: number, animate: boolean) => {
    const current = propsRef.current.level;
    const back = target < current;
    const top = slotRefs.current[back ? current : target];
    const under = slotRefs.current[back ? target : current];
    const shade = shadeRef.current;
    const transition = animate && !reducedMotion() ? `transform ${SETTLE_MS}ms ease-out` : "";
    const p = Math.max(0, Math.min(1, progress));
    // 위 화면(더 깊은 단계)이 아래 화면(목록) 위로 미끄러진다
    const topX = back ? p * 100 : (1 - p) * 100;
    const underX = back ? -UNDER_SHIFT * 100 * (1 - p) : -UNDER_SHIFT * 100 * p;
    if (top) {
      top.style.transition = transition;
      top.style.transform = `translate3d(${topX}%, 0, 0)`;
    }
    if (under) {
      under.style.transition = transition;
      under.style.transform = `translate3d(${underX}%, 0, 0)`;
    }
    if (shade) {
      shade.style.transition = transition ? `opacity ${SETTLE_MS}ms ease-out` : "";
      shade.style.opacity = String(0.28 * (back ? 1 - p : p));
    }
  }, []);

  const finish = useCallback(
    (target: number, go: boolean) => {
      settlingRef.current = true;
      const current = propsRef.current.level;
      const back = target < current;
      place(target, go ? 1 : 0, true);
      window.setTimeout(
        () => {
          settlingRef.current = false;
          if (go) {
            propsRef.current.onGo(target);
          } else {
            const top = slotRefs.current[back ? current : target];
            const under = slotRefs.current[back ? target : current];
            for (const slot of [top, under]) {
              if (!slot) continue;
              slot.style.transform = "";
              slot.style.transition = "";
            }
          }
          setExtra(null);
        },
        reducedMotion() ? 0 : SETTLE_MS,
      );
    },
    [place],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const onStart = (event: TouchEvent) => {
      if (settlingRef.current || event.touches.length !== 1) {
        gestureRef.current = null;
        return;
      }
      const touch = event.touches[0];
      if (!touch) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(NO_SWIPE) || (isIosBrowser() && touch.clientX < 24)) {
        gestureRef.current = null;
        return;
      }
      const now = performance.now();
      gestureRef.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        lastX: touch.clientX,
        lastT: now,
        speed: 0,
        target: null,
        dx: 0,
      };
    };

    const onMove = (event: TouchEvent) => {
      const gesture = gestureRef.current;
      const touch = event.touches[0];
      if (!gesture || gesture.target === false || !touch) return;
      const dx = touch.clientX - gesture.startX;
      const dy = touch.clientY - gesture.startY;
      if (gesture.target === null) {
        if (Math.abs(dx) < LOCK_PX && Math.abs(dy) < LOCK_PX) return;
        const sideways = Math.abs(dx) > Math.abs(dy) * 1.2;
        const next = propsRef.current.level + (dx > 0 ? -1 : 1);
        const from = event.target instanceof Element ? event.target : null;
        if (
          !sideways ||
          next < 0 ||
          next > 2 ||
          !propsRef.current.canGo(next) ||
          scrollsSideways(from, root, dx) ||
          window.getSelection()?.toString()
        ) {
          gesture.target = false;
          return;
        }
        gesture.target = next;
        setExtra(next);
      }
      event.preventDefault(); // 넘기는 동안 세로 스크롤과 브라우저 뒤로 가기를 막는다
      const now = performance.now();
      const elapsed = Math.max(1, now - gesture.lastT);
      gesture.speed = (touch.clientX - gesture.lastX) / elapsed;
      gesture.lastX = touch.clientX;
      gesture.lastT = now;
      const back = gesture.target < propsRef.current.level;
      // 가려는 쪽 반대로는 움직이지 않는다
      gesture.dx = back ? Math.max(0, dx) : Math.min(0, dx);
      place(gesture.target, Math.abs(gesture.dx) / Math.max(1, root.clientWidth), false);
    };

    const onEnd = () => {
      const gesture = gestureRef.current;
      gestureRef.current = null;
      if (!gesture || typeof gesture.target !== "number") return;
      const back = gesture.target < propsRef.current.level;
      const progress = Math.abs(gesture.dx) / Math.max(1, root.clientWidth);
      const flick = back ? gesture.speed > FLICK_SPEED : gesture.speed < -FLICK_SPEED;
      finish(gesture.target, progress > GO_RATIO || (flick && progress > 0.08));
    };

    // 잡는 단계(capture)에서 듣는다: 동영상 조절 단추처럼 손가락 이벤트를 멈추는 것 위에서도 넘길 수 있게
    root.addEventListener("touchstart", onStart, { passive: true, capture: true });
    root.addEventListener("touchmove", onMove, { passive: false, capture: true });
    root.addEventListener("touchend", onEnd, { capture: true });
    root.addEventListener("touchcancel", onEnd, { capture: true });
    return () => {
      root.removeEventListener("touchstart", onStart, { capture: true });
      root.removeEventListener("touchmove", onMove, { capture: true });
      root.removeEventListener("touchend", onEnd, { capture: true });
      root.removeEventListener("touchcancel", onEnd, { capture: true });
    };
  }, [finish, place]);

  // 손가락이 처음 닿은 방향의 이웃 화면은 위치를 먼저 잡아 두고 그린다(깜박이지 않게)
  useEffect(() => {
    if (extra === null) return;
    const gesture = gestureRef.current;
    const progress = gesture ? Math.abs(gesture.dx) / Math.max(1, rootRef.current?.clientWidth ?? 1) : 0;
    place(extra, progress, false);
  }, [extra, place]);

  const deeper = extra !== null && extra > level ? extra : level; // 위에 놓일 화면
  return (
    <div className="swipe-deck" ref={rootRef}>
      {LEVELS.map((slotLevel) => {
        const shown = slotLevel === level || slotLevel === extra;
        const startX = slotLevel === extra ? (extra > level ? "translate3d(100%, 0, 0)" : `translate3d(-${UNDER_SHIFT * 100}%, 0, 0)`) : undefined;
        return (
          <div
            key={slotLevel}
            ref={(node) => {
              slotRefs.current[slotLevel] = node;
            }}
            className={shown ? `swipe-slot swipe-slot-on${slotLevel === deeper && extra !== null ? " swipe-slot-top" : ""}` : "swipe-slot"}
            style={startX ? { transform: startX } : undefined}
            aria-hidden={slotLevel !== level || undefined}
            inert={slotLevel !== level || undefined}
          >
            {shown && render(slotLevel)}
          </div>
        );
      })}
      <div className={extra !== null ? "swipe-shade swipe-shade-on" : "swipe-shade"} ref={shadeRef} aria-hidden="true" />
    </div>
  );
}

/** 휴대폰에서 오른쪽에서 열린 판(서랍 등)을 오른쪽으로 밀어 닫기 */
export function useSwipeToClose(ref: { current: HTMLElement | null }, onClose: () => void): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const panel = ref.current;
    if (!panel || !window.matchMedia("(max-width: 640px)").matches) return;
    let gesture: { x: number; y: number; dx: number; lastX: number; lastT: number; speed: number; on: boolean | null } | null =
      null;
    const reset = (animate: boolean) => {
      panel.style.transition = animate && !reducedMotion() ? `transform ${SETTLE_MS}ms ease-out` : "";
      panel.style.transform = "";
    };
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      const target = event.target instanceof Element ? event.target : null;
      if (event.touches.length !== 1 || !touch || target?.closest("input, textarea, select, [contenteditable='true']")) {
        gesture = null;
        return;
      }
      gesture = { x: touch.clientX, y: touch.clientY, dx: 0, lastX: touch.clientX, lastT: performance.now(), speed: 0, on: null };
    };
    const onMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!gesture || gesture.on === false || !touch) return;
      const dx = touch.clientX - gesture.x;
      const dy = touch.clientY - gesture.y;
      if (gesture.on === null) {
        if (Math.abs(dx) < LOCK_PX && Math.abs(dy) < LOCK_PX) return;
        const from = event.target instanceof Element ? event.target : null;
        gesture.on = dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.2 && !scrollsSideways(from, panel.parentElement ?? panel, dx);
        if (!gesture.on) return;
      }
      event.preventDefault();
      const now = performance.now();
      gesture.speed = (touch.clientX - gesture.lastX) / Math.max(1, now - gesture.lastT);
      gesture.lastX = touch.clientX;
      gesture.lastT = now;
      gesture.dx = Math.max(0, dx);
      panel.style.transition = "";
      panel.style.transform = `translate3d(${gesture.dx}px, 0, 0)`;
    };
    const onEnd = () => {
      const done = gesture;
      gesture = null;
      if (!done?.on) return;
      const progress = done.dx / Math.max(1, panel.clientWidth);
      if (progress > GO_RATIO || (done.speed > FLICK_SPEED && progress > 0.08)) {
        panel.style.transition = reducedMotion() ? "" : `transform ${SETTLE_MS}ms ease-out`;
        panel.style.transform = "translate3d(100%, 0, 0)";
        window.setTimeout(() => closeRef.current(), reducedMotion() ? 0 : SETTLE_MS);
      } else {
        reset(true);
      }
    };
    panel.addEventListener("touchstart", onStart, { passive: true, capture: true });
    panel.addEventListener("touchmove", onMove, { passive: false, capture: true });
    panel.addEventListener("touchend", onEnd, { capture: true });
    panel.addEventListener("touchcancel", onEnd, { capture: true });
    return () => {
      panel.removeEventListener("touchstart", onStart, { capture: true });
      panel.removeEventListener("touchmove", onMove, { capture: true });
      panel.removeEventListener("touchend", onEnd, { capture: true });
      panel.removeEventListener("touchcancel", onEnd, { capture: true });
    };
  }, [ref]);
}

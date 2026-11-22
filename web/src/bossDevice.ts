// 위장 화면의 '더 숨기기'(자동 위장, 전체 화면, 돌아올 때 잠그기)는 기기마다 따로(이 브라우저에 저장).
// 회사 컴퓨터에서는 켜고 휴대폰에서는 끄는 식으로. 아직 안 정한 기기는 예전 계정 설정 값을 쓴다
import { useEffect, useState } from "react";

export interface BossDevice {
  auto: boolean;
  fullscreen: boolean;
  relock: boolean;
}

const KEY = "mos.bossDevice";
const EVENT = "mos-boss-device";

/** 계정 설정(예전 값)을 바탕으로 이 기기 값 */
export function readBossDevice(fallback: BossDevice): BossDevice {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fallback;
    const value = JSON.parse(raw) as Partial<BossDevice>;
    return {
      auto: typeof value.auto === "boolean" ? value.auto : fallback.auto,
      fullscreen: typeof value.fullscreen === "boolean" ? value.fullscreen : fallback.fullscreen,
      relock: typeof value.relock === "boolean" ? value.relock : fallback.relock,
    };
  } catch {
    return fallback;
  }
}

export function saveBossDevice(current: BossDevice, changes: Partial<BossDevice>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...current, ...changes }));
  } catch {
    // 저장을 못 하면 이번 화면에서만
  }
  window.dispatchEvent(new Event(EVENT));
}

export function useBossDevice(fallback: BossDevice): BossDevice {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const onChange = () => setTick((value) => value + 1);
    window.addEventListener(EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);
  void tick;
  return readBossDevice(fallback);
}

// 알림 소리. 기기마다 다르게 쓰는 경우가 많아서(회사 컴퓨터는 끄고 휴대폰은 켜기) 이 브라우저에만 저장한다.
// 소리 파일 없이 브라우저에서 짧은 '띵' 두 음을 만든다(업무 메신저처럼 평범하게)
import { useEffect, useState } from "react";

export interface SoundSetting {
  on: boolean;
  /** 0~100 */
  volume: number;
}

const KEY = "mos.notifySound";
const EVENT = "mos-notify-sound";
const MIN_GAP_MS = 2500; // 알림이 몰려도 연달아 울리지 않게
let lastPlayed = 0;
let audio: AudioContext | null = null;

export function readSound(): SoundSetting {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<SoundSetting>;
    const volume = typeof value.volume === "number" && Number.isFinite(value.volume) ? value.volume : 60;
    return { on: value.on === true, volume: Math.min(100, Math.max(0, Math.round(volume))) };
  } catch {
    return { on: false, volume: 60 };
  }
}

export function saveSound(setting: SoundSetting): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(setting));
  } catch {
    // 저장을 못 해도 지금 화면에는 적용한다
  }
  window.dispatchEvent(new Event(EVENT));
}

export function useSound(): SoundSetting {
  const [setting, setSetting] = useState(readSound);
  useEffect(() => {
    const onChange = () => setSetting(readSound());
    window.addEventListener(EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);
  return setting;
}

/** 소리 내기. 브라우저는 사용자가 페이지를 한 번이라도 누른 뒤에만 소리를 허락한다 */
export function playSound(setting: SoundSetting = readSound(), force = false): void {
  if (!force && (!setting.on || setting.volume <= 0)) return;
  const now = Date.now();
  if (!force && now - lastPlayed < MIN_GAP_MS) return;
  lastPlayed = now;
  try {
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return;
    audio = audio ?? new Context();
    if (audio.state === "suspended") void audio.resume();
    const peak = (setting.volume / 100) * 0.25;
    const start = audio.currentTime + 0.01;
    for (const [offset, frequency] of [
      [0, 880],
      [0.12, 1318.5],
    ] as const) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = "sine";
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start + offset);
      gain.gain.linearRampToValueAtTime(peak, start + offset + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.35);
      osc.connect(gain).connect(audio.destination);
      osc.start(start + offset);
      osc.stop(start + offset + 0.4);
    }
  } catch {
    // 소리를 못 내도 알림은 그대로
  }
}

// 대화 글씨 크기. 기기마다 다르게 쓰는 경우가 많아서(컴퓨터는 보통, 휴대폰은 크게) 이 브라우저에만 저장한다.
// 테마마다 정해 둔 글씨 크기의 비율을 그대로 두고 대화 부분만 함께 키우거나 줄인다(CSS 변수 --text-zoom)
import { useEffect, useState } from "react";

export const TEXT_SIZES = [
  { value: 90, label: "작게" },
  { value: 100, label: "보통" },
  { value: 112, label: "크게" },
  { value: 125, label: "아주 크게" },
] as const;

export type TextSize = (typeof TEXT_SIZES)[number]["value"];

const KEY = "mos.textSize";
const EVENT = "mos-text-size";

export function readTextSize(): TextSize {
  try {
    const value = Number(localStorage.getItem(KEY));
    return TEXT_SIZES.some((size) => size.value === value) ? (value as TextSize) : 100;
  } catch {
    return 100;
  }
}

export function applyTextSize(size: TextSize = readTextSize()): void {
  document.documentElement.style.setProperty("--text-zoom", String(size / 100));
}

export function saveTextSize(size: TextSize): void {
  try {
    localStorage.setItem(KEY, String(size));
  } catch {
    // 저장을 못 해도 지금 화면에는 적용한다
  }
  applyTextSize(size);
  window.dispatchEvent(new Event(EVENT));
}

export function useTextSize(): TextSize {
  const [size, setSize] = useState(readTextSize);
  useEffect(() => {
    const onChange = () => setSize(readTextSize());
    window.addEventListener(EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);
  return size;
}

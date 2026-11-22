// 위젯에 보일 카테고리(이 기기에서만, 2026-11-23 사용자 요청 '회사에서는 회사 카테고리만').
// 이 브라우저의 localStorage에만 둔다. 비어 있으면 모두 보인다. 지운 카테고리 id는 그냥 무시된다.
import { useEffect, useState } from "react";

const KEY = "mos.todo.widget.categories";
const EVENT = "mos-widget-categories";
const MAX = 100;

export function readWidgetCategories(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === "string" && /^\d{1,18}$/.test(id)).slice(0, MAX)
      : [];
  } catch {
    return [];
  }
}

export function saveWidgetCategories(ids: string[]): void {
  try {
    if (ids.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(ids.slice(0, MAX)));
  } catch {
    // 저장을 못 해도 지금 창에는 적용한다
  }
  window.dispatchEvent(new Event(EVENT));
}

/** 고른 카테고리 id(빈 목록 = 모두). 다른 창(위젯 창, 본 화면)에서 바꿔도 따라온다 */
export function useWidgetCategories(): string[] {
  const [ids, setIds] = useState(readWidgetCategories);
  useEffect(() => {
    const update = () => setIds(readWidgetCategories());
    const onStorage = (event: StorageEvent) => {
      if (event.key === KEY || event.key === null) update();
    };
    window.addEventListener(EVENT, update);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT, update);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return ids;
}

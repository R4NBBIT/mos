// 지금 열린 계정이 할 일(공개 전 기능)을 쓸 수 있는지. App이 세션을 받으면 정한다.
// 설정 화면의 위장 화면 고르기처럼 세션을 직접 받지 않는 곳이 읽는다(서버가 진짜 검사를 한다)
import { useSyncExternalStore } from "react";

let allowed = false;
const listeners = new Set<() => void>();

export function setTodoAllowed(value: boolean): void {
  if (allowed === value) return;
  allowed = value;
  listeners.forEach((listener) => listener());
}

export function todoAllowed(): boolean {
  return allowed;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTodoAllowed(): boolean {
  return useSyncExternalStore(subscribe, todoAllowed);
}

/** 위장 화면 '내 할 일'의 파일 이름과 탭 아이콘(테마마다 그 프로그램처럼) */
export function todoBossTitle(theme: string): { name: string; icon: "sheet" | "memo" | "note" | "word" } {
  if (theme === "sheet") return { name: "업무 체크리스트.xlsx", icon: "sheet" };
  if (theme === "memo") return { name: "체크리스트.txt - 메모장", icon: "memo" };
  if (theme === "word") return { name: "업무 체크리스트.docx", icon: "word" };
  return { name: "업무 체크리스트", icon: "note" };
}

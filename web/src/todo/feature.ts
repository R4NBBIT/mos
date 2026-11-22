// 지금 열린 계정이 TODO(공개 전 기능)을 쓸 수 있는지. App이 세션을 받으면 정한다.
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

/** 위장 화면 '내 TODO'의 파일 이름과 탭 아이콘(테마마다 그 프로그램처럼) */
export function todoBossTitle(theme: string): { name: string; icon: "sheet" | "memo" | "note" | "word" } {
  if (theme === "sheet") return { name: "TODO.xlsx", icon: "sheet" };
  if (theme === "memo") return { name: "TODO.txt - 메모장", icon: "memo" };
  if (theme === "word") return { name: "TODO.docx", icon: "word" };
  return { name: "TODO", icon: "note" };
}

// ------------------------------------------------------------ AI 연결 승인 요청(#/connect/<ID>)
const PENDING_KEY = "mos.todo.connect";

/** 로그인하러 다녀와도 이어서 승인할 수 있게 이 탭에만 잠깐 남긴다(10분) */
export function rememberConnect(id: string): void {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ id, at: Date.now() }));
  } catch {
    // 저장소를 못 쓰면 주소로만
  }
}

export function pendingConnect(): string | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { id?: unknown; at?: unknown };
    if (typeof parsed.id !== "string" || typeof parsed.at !== "number" || Date.now() - parsed.at > 10 * 60_000) {
      sessionStorage.removeItem(PENDING_KEY);
      return null;
    }
    return parsed.id;
  } catch {
    return null;
  }
}

export function forgetConnect(): void {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // 괜찮음
  }
}

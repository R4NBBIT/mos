// 위장 화면이 떠 있는지. 떠 있는 동안에는 채팅을 '읽음'으로 남기지 않는다(보지 않았으니까)
let disguised = false;
const disguiseListeners = new Set<(value: boolean) => void>();

export function setDisguised(value: boolean): void {
  if (disguised === value) return;
  disguised = value;
  disguiseListeners.forEach((listener) => listener(value));
}

/** 위장이 켜지고 꺼질 때(할 일 위젯 창이 같이 숨는다) */
export function onDisguiseChange(listener: (value: boolean) => void): () => void {
  disguiseListeners.add(listener);
  return () => disguiseListeners.delete(listener);
}

export function isDisguised(): boolean {
  return disguised;
}

// 설정에서 새 보스키를 누르는 중에는 보스키로 반응하지 않는다
let capturing = false;

export function setCapturingKey(value: boolean): void {
  capturing = value;
}

export function isCapturingKey(): boolean {
  return capturing;
}

// 같은 브라우저의 ㅁㅇㅅ 창끼리(본 화면, 위젯 창, 항상 위 창) 할 일 바뀜과 위장을 알린다.
// 다른 기기(휴대폰 위젯, AI)에서 바꾼 것은 창으로 돌아올 때와 주기적으로 다시 받는다.
const NAME = "mos-todo";
export const TODO_CHANGED_EVENT = "mos-todo-changed";

export type TodoSyncMessage = "changed" | "disguise";

let channel: BroadcastChannel | null | undefined;

function shared(): BroadcastChannel | null {
  if (channel === undefined) {
    channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(NAME);
  }
  return channel;
}

/** 할 일을 바꿨다(이 창과 다른 창 모두 다시 받게) */
export function announceTodoChange(): void {
  shared()?.postMessage("changed" satisfies TodoSyncMessage);
  window.dispatchEvent(new Event(TODO_CHANGED_EVENT));
}

/** 위장했다(다른 창의 위젯도 숨게) */
export function announceDisguise(): void {
  shared()?.postMessage("disguise" satisfies TodoSyncMessage);
}

/** 다른 창의 알림 듣기(includeHere면 이 창에서 바꾼 것도) */
export function onTodoSync(handler: (message: TodoSyncMessage) => void, includeHere = false): () => void {
  const listener = new BroadcastChannel(NAME);
  const fromOthers = (event: MessageEvent) => {
    if (event.data === "changed" || event.data === "disguise") handler(event.data);
  };
  const fromHere = () => handler("changed");
  listener.addEventListener("message", fromOthers);
  if (includeHere) window.addEventListener(TODO_CHANGED_EVENT, fromHere);
  return () => {
    listener.close();
    window.removeEventListener(TODO_CHANGED_EVENT, fromHere);
  };
}

/**
 * 할 일 화면이 다시 받아야 할 때: 다른 창에서 바꿈, 창으로 돌아옴, 보이는 동안 주기적으로(다른 기기).
 */
export function onTodoRefresh(reload: () => void, everyMs: number): () => void {
  const stopSync = onTodoSync((message) => {
    if (message === "changed") reload();
  });
  const onVisible = () => {
    if (document.visibilityState === "visible") reload();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
  const timer = window.setInterval(() => {
    if (document.visibilityState === "visible") reload();
  }, everyMs);
  return () => {
    stopSync();
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onVisible);
    window.clearInterval(timer);
  };
}

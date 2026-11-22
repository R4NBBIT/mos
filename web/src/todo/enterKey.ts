import { type KeyboardEvent, useRef } from "react";

/**
 * 한글 입력 중 Enter: 크롬은 글자를 확정하는 Enter를 입력 중(isComposing)으로 보내고 폼을 보내지 않는다.
 * 그래서 입력 중 Enter는 기억해 두었다가 글자가 확정되면(compositionend) 그때 보낸다. Enter 한 번이면 된다.
 */
export function useEnterKey(onEnter: () => void) {
  const composing = useRef(false);
  const pending = useRef(false);
  const latest = useRef(onEnter);
  latest.current = onEnter;
  return {
    onCompositionStart: () => {
      composing.current = true;
    },
    onCompositionEnd: () => {
      composing.current = false;
      if (pending.current) {
        pending.current = false;
        window.setTimeout(() => latest.current(), 0); // 확정된 글자가 값에 들어간 다음
      }
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Enter" && event.keyCode !== 13) return;
      event.preventDefault();
      if (event.nativeEvent.isComposing || composing.current) {
        pending.current = true;
        return;
      }
      latest.current();
    },
  };
}

// 기기 모양 판단(키보드·마우스가 없는 휴대폰·태블릿인지)

/** 손가락으로만 조작하는 기기(휴대폰·태블릿). 키보드를 붙인 태블릿은 아닐 수 있다 */
export function isTouchOnly(): boolean {
  try {
    return window.matchMedia("(pointer: coarse)").matches && !window.matchMedia("(any-pointer: fine)").matches;
  } catch {
    return false;
  }
}

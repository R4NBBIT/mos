// 기기 모양 판단(키보드·마우스가 없는 휴대폰·태블릿인지)

/** 휴대폰, 태블릿 운영체제(안드로이드, 아이폰, 아이패드). 아이패드는 맥처럼 보여서 손가락 수로 가린다 */
function isMobileOs(): boolean {
  const agent = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(agent)) return true;
  return /Macintosh/.test(agent) && navigator.maxTouchPoints > 1;
}

/**
 * 손가락으로 쓰는 기기(휴대폰·태블릿). 펜을 쓰는 갤럭시(S펜)는 '정밀한 포인터'가 있다고 나와서
 * 화면 판단만으로는 컴퓨터로 잘못 보므로 운영체제도 같이 본다
 */
export function isTouchOnly(): boolean {
  try {
    if (isMobileOs()) return true;
    return window.matchMedia("(pointer: coarse)").matches && !window.matchMedia("(any-pointer: fine)").matches;
  } catch {
    return false;
  }
}

// 위장 화면 안에서 TODO로 가기(2026-11-23 사용자 요청).
// 위장 모양마다 그 문서에 원래 있을 법한 자리(시트 탭, 메뉴 칸, 페이지 목록)에 숨겨 둔다.
import { createContext, useContext } from "react";

export const BossTodoContext = createContext<(() => void) | null>(null);

export function useBossTodo(): (() => void) | null {
  return useContext(BossTodoContext);
}

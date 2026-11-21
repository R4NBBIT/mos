// 화면 곳곳에서 계정 설정(문서 제목, 탭 제목 등)을 읽고 바로 고치기 위한 공유 값
import { createContext, useContext } from "react";
import type { SettingsChanges } from "./api";
import { DEFAULT_SETTINGS, type Settings } from "./theme";

export interface LookValue {
  settings: Settings;
  /** 바로 화면에 반영하고 계정에 저장(실패하면 되돌림) */
  save: (changes: SettingsChanges) => Promise<void>;
}

export const LookContext = createContext<LookValue>({ settings: DEFAULT_SETTINGS, save: async () => {} });

export function useLook(): LookValue {
  return useContext(LookContext);
}

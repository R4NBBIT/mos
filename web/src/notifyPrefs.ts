// 이 기기(브라우저)의 알림 설정. 서버에 기기마다 따로 저장된다(회사 컴퓨터는 끄고 휴대폰만 켜기 등).
import { createContext, useContext } from "react";
import type { HiddenNotify, NotifyScope } from "./theme";

export interface NotifyPrefs {
  notify: boolean;
  scope: NotifyScope;
  preview: boolean;
  /** 숨긴 서버와 채널의 알림: 알리지 않기, 나를 부른 것만, 숨기지 않은 곳과 같게 */
  hidden: HiddenNotify;
}

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = { notify: true, scope: "pinned", preview: false, hidden: "mentions" };

export function cleanNotifyPrefs(value: unknown): NotifyPrefs {
  const raw = (value && typeof value === "object" ? value : {}) as Partial<NotifyPrefs>;
  return {
    notify: raw.notify !== false,
    scope: raw.scope === "mentions" || raw.scope === "all" ? raw.scope : "pinned",
    preview: raw.preview === true,
    hidden: raw.hidden === "none" || raw.hidden === "all" ? raw.hidden : "mentions",
  };
}

export interface NotifyPrefsValue {
  prefs: NotifyPrefs;
  save: (changes: Partial<NotifyPrefs>) => Promise<void>;
}

export const NotifyPrefsContext = createContext<NotifyPrefsValue>({
  prefs: DEFAULT_NOTIFY_PREFS,
  save: async () => {},
});

export function useNotifyPrefs(): NotifyPrefsValue {
  return useContext(NotifyPrefsContext);
}

// TODO 알림 설정(SCR-10 일부, NOTI-01, NOTI-03): TODO 알림(시각)을 몇 분 미리, 아침 요약 시각.
// 실제 알림은 ㅁㅇㅅ 웹 푸시로 온다(기기 알림은 ㅁㅇㅅ 설정 > 알림에서 켬)
import { type ReactNode, useEffect, useState } from "react";
import { useNotifyPrefs } from "../notifyPrefs";
import { askPopupPermission, popupSupport, type PopupSupport } from "../useNotifications";
import {
  type AlertLead,
  type BossMode,
  browserTz,
  fetchAlertPrefs,
  fetchTodoNews,
  markTodoNewsSeen,
  type MorningVia,
  saveAlertPrefs,
  type TodoAlertPrefs,
  todoErrorText,
  type TodoNewsItem,
} from "./todoApi";

const LEADS: { value: AlertLead | null; label: string }[] = [
  { value: null, label: "끔" },
  { value: 0, label: "정각" },
  { value: 10, label: "10분 전" },
  { value: 30, label: "30분 전" },
  { value: 60, label: "1시간 전" },
];

const VIAS: { value: MorningVia; label: string }[] = [
  { value: "push", label: "기기 알림" },
  { value: "dm", label: "봇 DM" },
  { value: "both", label: "둘 다" },
];

function agoLabel(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() / 1000 - at) / 60));
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.round(hours / 24)}일 전`;
}

/** 소식(NOTI-06): 보낸 TODO 알림. 펼치면 읽음으로 */
function TodoNewsList({ onSeen }: { onSeen: () => void }) {
  const [items, setItems] = useState<TodoNewsItem[] | null>(null);
  const [unreadAt, setUnreadAt] = useState(0);
  useEffect(() => {
    fetchTodoNews()
      .then((news) => {
        setItems(news.items);
        setUnreadAt(news.unread);
        if (news.unread > 0)
          void markTodoNewsSeen()
            .then(onSeen)
            .catch(() => {});
      })
      .catch(() => setItems([]));
  }, [onSeen]);
  if (items === null) return null;
  if (items.length === 0) return <p className="todo-hint">아직 소식이 없어요.</p>;
  return (
    <ul className="todo-news">
      {items.slice(0, 10).map((item, index) => (
        <li key={item.id} className={index < unreadAt ? "todo-news-item todo-news-new" : "todo-news-item"}>
          <span className="todo-news-title">{item.title}</span>
          <span className="todo-news-body">{item.body}</span>
          <span className="todo-news-time">{agoLabel(item.created_at)}</span>
        </li>
      ))}
    </ul>
  );
}

/** 이 기기에서 TODO 알림 받기(채팅 알림과 따로). 브라우저 허용 상태도 함께 보여 준다 */
function DeviceTodoSetting() {
  const { prefs: device, save } = useNotifyPrefs();
  const [popup, setPopup] = useState<PopupSupport>(popupSupport);
  const note = !device.todo
    ? "이 기기에서는 TODO 알림을 받지 않아요. 알림 받는 곳이 봇 DM이면 DM은 그대로 와요."
    : popup === "denied"
      ? "브라우저에서 알림이 막혀 있어서 알림 창은 뜨지 않고, 화면 안 작은 알림과 소식에만 남아요. 주소창 왼쪽 자물쇠에서 알림을 허용해 주세요."
      : popup === "unsupported"
        ? "이 브라우저는 알림 창을 띄울 수 없어서 화면 안 작은 알림과 소식에만 남아요. 아이폰은 사파리에서 '홈 화면에 추가'한 뒤에 받을 수 있어요."
        : popup === "default"
          ? "알림 창을 띄우려면 이 브라우저에서 알림을 허용해 주세요."
          : "이 기기에서 TODO 알림을 받아요. ㅁㅇㅅ 설정의 채팅 알림과는 따로예요.";
  return (
    <Setting name="이 기기" help={note}>
      <div className="todo-setting-row">
        <label className="todo-switch">
          <input
            type="checkbox"
            role="switch"
            checked={device.todo}
            onChange={(event) => void save({ todo: event.target.checked })}
          />
          <span className="todo-switch-track" aria-hidden="true" />
          <span>{device.todo ? "TODO 알림 받기" : "받지 않기"}</span>
        </label>
        {device.todo && popup === "default" && (
          <button
            type="button"
            className="todo-small-button todo-primary"
            onClick={() => void askPopupPermission().then(setPopup)}
          >
            알림 허용하기
          </button>
        )}
      </div>
    </Setting>
  );
}

function Segment<T extends string | number | null>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="todo-segment" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={value === option.value ? "todo-segment-on" : undefined}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const BOSS: { value: BossMode; label: string; help: string }[] = [
  {
    value: "off",
    label: "안 받기",
    help: "위장 화면일 때는 알림을 띄우지 않아요.",
  },
  {
    value: "silent",
    label: "조용히",
    help: "내용과 소리 없이 알림 창만 떠요.",
  },
  {
    value: "full",
    label: "그대로",
    help: "평소처럼 TODO 내용과 소리까지 알려요.",
  },
];

/** 설정 한 줄: 왼쪽 이름, 오른쪽 고르기와 그 아래 짧은 설명 */
function Setting({ name, help, children }: { name: string; help?: string; children: ReactNode }) {
  return (
    <div className="todo-setting">
      <span className="todo-setting-name">{name}</span>
      <div className="todo-setting-body">
        {children}
        {help && <p className="todo-setting-help">{help}</p>}
      </div>
    </div>
  );
}

export default function TodoAlertPanel({ onSeen }: { onSeen: () => void }) {
  const [prefs, setPrefs] = useState<TodoAlertPrefs | null>(null);
  const [morningText, setMorningText] = useState("08:00");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetchAlertPrefs()
      .then((value) => {
        setPrefs(value);
        if (value.morning) setMorningText(value.morning);
      })
      .catch(() => setError("불러오지 못했어요."));
  }, []);
  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 1500);
    return () => window.clearTimeout(timer);
  }, [saved]);

  const save = async (changes: Partial<TodoAlertPrefs>) => {
    setError("");
    try {
      const tz = browserTz();
      setPrefs(await saveAlertPrefs(tz ? { ...changes, tz } : changes));
      setSaved(true);
    } catch (failure) {
      setError(todoErrorText(failure));
    }
  };
  const boss = BOSS.find((item) => item.value === prefs?.boss_mode) ?? BOSS[0];

  return (
    <section className="todo-alerts todo-alerts-page" aria-label="소식과 알림">
      <p className="settings-device-note">
        알림 설정의 <strong>'이 기기'</strong>는 지금 쓰는 이 기기에만 적용돼요. 그 아래 설정은 이 계정을 쓰는 모든
        기기에 같이 적용돼요.
      </p>
      <div className="todo-alerts-head">
        <strong>소식</strong>
      </div>
      <p className="todo-setting-help">
        친구 요청과 수락, 내 TODO에 달린 반응, 보낸 TODO 알림과 아침 요약이 여기 모여요.
      </p>
      <TodoNewsList onSeen={onSeen} />
      <div className="todo-alerts-head todo-alerts-sub">
        <strong>알림 설정</strong>
        <span className={saved ? "todo-saved todo-saved-on" : "todo-saved"} role="status">
          {saved ? "저장됨" : ""}
        </span>
      </div>
      {prefs === null ? (
        <p className="todo-setting-help">{error || "불러오는 중…"}</p>
      ) : (
        <>
          <DeviceTodoSetting />
          <Setting name="TODO 알림" help="시각을 정한 TODO 중 아직 끝내지 않은 것만 알려요.">
            <Segment
              label="TODO 알림"
              options={LEADS}
              value={prefs.alert_lead}
              onChange={(value) => void save({ alert_lead: value })}
            />
          </Setting>
          <Setting name="아침 요약" help="오늘 남은 TODO를 모두 알려요.">
            <div className="todo-setting-row">
              <label className="todo-switch">
                <input
                  type="checkbox"
                  role="switch"
                  checked={prefs.morning !== null}
                  onChange={(event) =>
                    void save({
                      morning: event.target.checked ? morningText : null,
                    })
                  }
                />
                <span className="todo-switch-track" aria-hidden="true" />
                <span>{prefs.morning !== null ? "켜짐" : "꺼짐"}</span>
              </label>
              {prefs.morning !== null && (
                <input
                  className="todo-setting-time"
                  type="time"
                  aria-label="아침 요약 시각"
                  value={morningText}
                  onChange={(event) => {
                    setMorningText(event.target.value);
                    if (event.target.value) void save({ morning: event.target.value });
                  }}
                />
              )}
            </div>
          </Setting>
          {(prefs.morning !== null || prefs.alert_lead !== null) && (
            <Setting
              name="알림 받는 곳"
              help={
                prefs.morning_via === "push"
                  ? "TODO 알림과 아침 요약 모두 여기로 가요."
                  : "TODO 알림과 아침 요약 모두 여기로 가요. 봇 DM은 ㅁㅇㅅ 봇과 같은 서버에 있고 서버 멤버의 DM을 허용해야 와요. 못 보내면 소식에 남겨요."
              }
            >
              <Segment
                label="알림 받는 곳"
                options={VIAS}
                value={prefs.morning_via}
                onChange={(value) => void save({ morning_via: value })}
              />
            </Setting>
          )}
          <Setting name="위장 중" help={boss?.help}>
            <Segment
              label="위장 화면일 때 알림"
              options={BOSS}
              value={prefs.boss_mode}
              onChange={(value) => void save({ boss_mode: value })}
            />
          </Setting>
          {error && <p className="todo-error">{error}</p>}
        </>
      )}
    </section>
  );
}

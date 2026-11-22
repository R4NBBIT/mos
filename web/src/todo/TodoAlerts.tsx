// 할 일 알림 설정(SCR-10 일부, NOTI-01, NOTI-03): 시각 알림을 몇 분 미리, 아침 요약 시각.
// 실제 알림은 ㅁㅇㅅ 웹 푸시로 온다(기기 알림은 ㅁㅇㅅ 설정 > 알림에서 켬)
import { useEffect, useState } from "react";
import {
  type AlertLead,
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

/** 소식(NOTI-06): 보낸 할 일 알림. 펼치면 읽음으로 */
function TodoNewsList({ onSeen }: { onSeen: () => void }) {
  const [items, setItems] = useState<TodoNewsItem[] | null>(null);
  const [unreadAt, setUnreadAt] = useState(0);
  useEffect(() => {
    fetchTodoNews()
      .then((news) => {
        setItems(news.items);
        setUnreadAt(news.unread);
        if (news.unread > 0) void markTodoNewsSeen().then(onSeen).catch(() => {});
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

function notificationsOff(): boolean {
  return typeof Notification === "undefined" || Notification.permission !== "granted";
}

export default function TodoAlertPanel({ onClose, onSeen }: { onClose: () => void; onSeen: () => void }) {
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

  const save = async (changes: Partial<TodoAlertPrefs>) => {
    setError("");
    setSaved(false);
    try {
      const tz = browserTz();
      setPrefs(await saveAlertPrefs(tz ? { ...changes, tz } : changes));
      setSaved(true);
    } catch (failure) {
      setError(todoErrorText(failure));
    }
  };

  return (
    <section className="todo-alerts" aria-label="할 일 알림">
      <div className="todo-alerts-head">
        <strong>소식</strong>
        <button type="button" className="todo-link-button" onClick={onClose}>
          닫기
        </button>
      </div>
      <TodoNewsList onSeen={onSeen} />
      <div className="todo-alerts-head todo-alerts-sub">
        <strong>알림 설정</strong>
      </div>
      {prefs === null ? (
        <p className="todo-hint">{error || "불러오는 중…"}</p>
      ) : (
        <>
          <div className="todo-prop">
            <span className="todo-prop-key">시각 알림</span>
            <div className="todo-segment" role="radiogroup" aria-label="시각 알림">
              {LEADS.map((lead) => (
                <button
                  key={String(lead.value)}
                  type="button"
                  role="radio"
                  aria-checked={prefs.alert_lead === lead.value}
                  className={prefs.alert_lead === lead.value ? "todo-segment-on" : undefined}
                  onClick={() => void save({ alert_lead: lead.value })}
                >
                  {lead.label}
                </button>
              ))}
            </div>
          </div>
          <div className="todo-prop">
            <span className="todo-prop-key">아침 요약</span>
            <span className="todo-prop-value">
              <label className="todo-check-line">
                <input
                  type="checkbox"
                  checked={prefs.morning !== null}
                  onChange={(event) => void save({ morning: event.target.checked ? morningText : null })}
                />
                켜기
              </label>
              <input
                type="time"
                aria-label="아침 요약 시각"
                value={morningText}
                disabled={prefs.morning === null}
                onChange={(event) => {
                  setMorningText(event.target.value);
                  if (event.target.value) void save({ morning: event.target.value });
                }}
              />
            </span>
          </div>
          {prefs.morning !== null && (
            <div className="todo-prop">
              <span className="todo-prop-key">요약 받기</span>
              <div className="todo-segment" role="radiogroup" aria-label="아침 요약 받는 방법">
                {VIAS.map((via) => (
                  <button
                    key={via.value}
                    type="button"
                    role="radio"
                    aria-checked={prefs.morning_via === via.value}
                    className={prefs.morning_via === via.value ? "todo-segment-on" : undefined}
                    onClick={() => void save({ morning_via: via.value })}
                  >
                    {via.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="todo-prop">
            <span className="todo-prop-key">위장 중</span>
            <span className="todo-prop-value">
              <label className="todo-check-line">
                <input
                  type="checkbox"
                  checked={prefs.boss_alerts}
                  onChange={(event) => void save({ boss_alerts: event.target.checked })}
                />
                위장 화면일 때도 할 일 알림 창 띄우기(내용 없이, 소리 없이)
              </label>
            </span>
          </div>
          {prefs.morning !== null && prefs.morning_via !== "push" && (
            <p className="todo-hint">봇 DM은 ㅁㅇㅅ 봇과 같은 서버에 있고 서버 멤버의 DM을 허용해야 와요. 못 보내면 소식에 남겨요.</p>
          )}
          <p className="todo-hint">
            시각을 정한, 아직 안 한 할 일만 알려요. 아침 요약은 오늘 남은 할 일 수와 앞 3개예요.
            {notificationsOff() && " 이 기기는 알림이 꺼져 있어요. ㅁㅇㅅ 설정 > 알림에서 켜 주세요."}
          </p>
          {error && <p className="todo-error">{error}</p>}
          {saved && !error && (
            <p className="todo-hint" role="status">
              저장했어요.
            </p>
          )}
        </>
      )}
    </section>
  );
}

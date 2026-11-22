// 할 일 알림 설정(SCR-10 일부, NOTI-01, NOTI-03): 시각 알림을 몇 분 미리, 아침 요약 시각.
// 실제 알림은 ㅁㅇㅅ 웹 푸시로 온다(기기 알림은 ㅁㅇㅅ 설정 > 알림에서 켬)
import { useEffect, useState } from "react";
import { type AlertLead, browserTz, fetchAlertPrefs, saveAlertPrefs, type TodoAlertPrefs, todoErrorText } from "./todoApi";

const LEADS: { value: AlertLead | null; label: string }[] = [
  { value: null, label: "끔" },
  { value: 0, label: "정각" },
  { value: 10, label: "10분 전" },
  { value: 30, label: "30분 전" },
  { value: 60, label: "1시간 전" },
];

function notificationsOff(): boolean {
  return typeof Notification === "undefined" || Notification.permission !== "granted";
}

export default function TodoAlertPanel({ onClose }: { onClose: () => void }) {
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
        <strong>알림</strong>
        <button type="button" className="todo-link-button" onClick={onClose}>
          닫기
        </button>
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

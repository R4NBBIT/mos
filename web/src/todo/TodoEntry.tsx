// 서버 목록 맨 위 'TODO' 줄(SCR-01). 허용된 계정에서만 그린다
import { useEffect, useState } from "react";
import type { Theme } from "../theme";
import { today } from "./dates";
import { fetchTodoDay, fetchTodoNews, TODO_NEWS_EVENT } from "./todoApi";

/** 지금 시각(HH:MM) */
function nowTime(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

/** 테마별 이름(ㅁㅇㅅ 왼쪽 목록처럼 업무 파일로 보이게) */
const LABELS: Record<Theme, { name: string; ext: string }> = {
  moon: { name: "TODO", ext: "" },
  night: { name: "TODO", ext: "" },
  sheet: { name: "TODO", ext: ".xlsx" },
  memo: { name: "TODO", ext: ".txt" },
  note: { name: "TODO", ext: "" },
  word: { name: "TODO", ext: ".docx" },
};

export default function TodoEntry({
  theme,
  preview,
  active,
  version,
  onOpen,
}: {
  theme: Theme;
  /** 공개 전('나만 보임' 표시) */
  preview: boolean;
  active: boolean;
  version: number;
  onOpen: () => void;
}) {
  const [left, setLeft] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [due, setDue] = useState(0);
  const [unread, setUnread] = useState(0);
  const [tick, setTick] = useState(0);
  // 1분마다, 새 TODO 알림이 오면 다시(시각이 지난 TODO, 안 읽은 소식)
  useEffect(() => {
    const again = () => setTick((value) => value + 1);
    const timer = window.setInterval(again, 60_000);
    window.addEventListener(TODO_NEWS_EVENT, again);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(TODO_NEWS_EVENT, again);
    };
  }, []);
  useEffect(() => {
    let stopped = false;
    fetchTodoDay(today())
      .then((data) => {
        if (stopped) return;
        const now = nowTime();
        setTotal(data.items.length);
        setLeft(data.items.filter((item) => !item.done).length);
        setDue(data.items.filter((item) => !item.done && item.time !== null && item.time <= now).length);
      })
      .catch(() => {});
    fetchTodoNews()
      .then((news) => !stopped && setUnread(news.unread))
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [version, tick]);
  const label = LABELS[theme] ?? LABELS.moon;
  const sub =
    left === null
      ? ""
      : due > 0
        ? `시각 지난 TODO ${due}개`
        : total === 0
          ? "오늘 TODO가 없어요"
          : left === 0
            ? "오늘 다 했어요"
            : `오늘 ${left}개 남음`;
  const classes = ["list-item", "todo-entry", active ? "list-item-active" : "", due > 0 ? "todo-entry-due" : ""];
  return (
    <section className="list-section todo-entry-section">
      <button
        type="button"
        className={classes.filter(Boolean).join(" ")}
        aria-current={active ? "page" : undefined}
        onClick={onOpen}
      >
        <span className="channel-mark todo-entry-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20">
            <rect x="2.5" y="2.5" width="15" height="15" rx="4" />
            <path d="M6.5 10.2l2.4 2.4 4.6-5" />
          </svg>
        </span>
        <span className="list-name">
          {label.name}
          {label.ext && <span className="skin-ext">{label.ext}</span>}
          {sub && <span className="list-sub">{sub}</span>}
        </span>
        {unread > 0 && <span className="todo-entry-dot" role="img" aria-label={`새 소식 ${unread}개`} />}
        {preview && <span className="todo-preview-chip">나만 보임</span>}
      </button>
    </section>
  );
}

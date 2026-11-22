// 서버 목록 맨 위 '할 일' 줄(SCR-01). 허용된 계정에서만 그린다
import { useEffect, useState } from "react";
import type { Theme } from "../theme";
import { today } from "./dates";
import { fetchTodoDays } from "./todoApi";

/** 테마별 이름(ㅁㅇㅅ 왼쪽 목록처럼 업무 파일로 보이게) */
const LABELS: Record<Theme, { name: string; ext: string }> = {
  moon: { name: "할 일", ext: "" },
  night: { name: "할 일", ext: "" },
  sheet: { name: "체크리스트", ext: ".xlsx" },
  memo: { name: "체크리스트", ext: ".txt" },
  note: { name: "체크리스트", ext: "" },
  word: { name: "체크리스트", ext: ".docx" },
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
  useEffect(() => {
    let stopped = false;
    const day = today();
    fetchTodoDays(day, day)
      .then((days) => {
        if (stopped) return;
        const info = days[day];
        setTotal(info?.total ?? 0);
        setLeft(info ? info.total - info.done : 0);
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [version]);
  const label = LABELS[theme] ?? LABELS.moon;
  const sub = left === null ? "" : total === 0 ? "오늘 할 일이 없어요" : left === 0 ? "오늘 다 했어요" : `오늘 ${left}개 남음`;
  return (
    <section className="list-section todo-entry-section">
      <button
        type="button"
        className={active ? "list-item todo-entry list-item-active" : "list-item todo-entry"}
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
        {preview && <span className="todo-preview-chip">나만 보임</span>}
      </button>
    </section>
  );
}

// TODO의 '알림'과 'AI 연결'을 위에 펼치는 대신 설정처럼 따로 여는 화면(2026-11-22 사용자 요청).
import { type ReactNode, useCallback } from "react";
import BackIcon from "../BackIcon";
import SplitToggle from "../SplitToggle";
import TodoAiPanel, { AiRequests } from "./TodoAi";
import TodoAlertPanel from "./TodoAlerts";
import { TODO_NEWS_EVENT } from "./todoApi";
import "./todo.css";

export type TodoPanelKind = "alerts" | "ai" | "trash";

const TITLES: Record<TodoPanelKind, { title: string; sub: string }> = {
  alerts: { title: "알림", sub: "소식과 알림 설정" },
  ai: { title: "AI 연결", sub: "Claude, ChatGPT에서 TODO 넣기" },
  trash: { title: "휴지통", sub: "삭제한 것은 7일 동안 되돌릴 수 있어요" },
};

export default function TodoPanelPage({
  kind,
  showBack,
  onBack,
  menu,
  onChanged,
}: {
  kind: TodoPanelKind;
  showBack: boolean;
  onBack: () => void;
  menu: ReactNode;
  onChanged: () => void;
}) {
  const seen = useCallback(() => window.dispatchEvent(new Event(TODO_NEWS_EVENT)), []);
  const text = TITLES[kind];
  return (
    <div className="room todo-room">
      <header className="room-header todo-header">
        <SplitToggle />
        {showBack && (
          <button type="button" className="back-button" onClick={onBack} aria-label="TODO로">
            <BackIcon />
          </button>
        )}
        <div className="room-title">
          <strong>{text.title}</strong>
          <span className="room-sub">{text.sub}</span>
        </div>
        {!showBack && (
          <div className="header-tools">
            <button type="button" className="header-tool" onClick={onBack}>
              <span className="header-tool-label todo-tool-always">TODO로</span>
            </button>
          </div>
        )}
        {menu}
      </header>
      <div className="todo-body todo-page-body">
        {kind === "alerts" ? (
          <TodoAlertPanel onSeen={seen} />
        ) : kind === "trash" ? (
          <section className="todo-alerts todo-alerts-page" aria-label="휴지통">
            <AiRequests show="trash" onChanged={onChanged} />
          </section>
        ) : (
          <TodoAiPanel onChanged={onChanged} />
        )}
      </div>
    </div>
  );
}

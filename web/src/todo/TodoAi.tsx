// AI 연결 관리(SCR-08): 연결 주소와 연결된 앱 목록(끊기). 앱별 붙이는 방법 설명은 두지 않음(2026-11-23 사용자 결정)
import { useEffect, useState } from "react";
import { dateWithWeekday } from "./dates";
import {
  decideAiPending,
  disconnectAi,
  fetchAiState,
  fetchConnections,
  restoreAiTrash,
  purgeAiTrash,
  TODO_NEWS_EVENT,
  type TodoAiPending,
  type TodoAiTrash,
  type TodoConnection,
} from "./todoApi";

function dayLabel(at: number | null): string {
  if (at === null) return "아직 안 씀";
  const value = new Date(at * 1000);
  return `${value.getMonth() + 1}월 ${value.getDate()}일`;
}

/** AI가 만든 요청 중 ㅁㅇㅅ에서 승인해야 하는 것, 휴지통(7일, 직접 지운 것과 AI가 지운 것) */
/** 초 단위 시각 → 이 기기 날짜(YYYY-MM-DD) */
function localDay(seconds: number): string {
  const value = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

export function AiRequests({
  onChanged,
  show = "pending",
}: {
  onChanged: () => void;
  /** pending: 승인 기다리는 요청만, trash: 휴지통만(휴지통은 따로 화면, 2026-11-23 사용자 요청) */
  show?: "pending" | "trash";
}) {
  const [opened, setOpened] = useState<string | null>(null);
  const [purging, setPurging] = useState<string | null>(null);
  const [state, setState] = useState<{
    pending: TodoAiPending[];
    trash: TodoAiTrash[];
  } | null>(null);
  const [message, setMessage] = useState("");
  const load = () =>
    fetchAiState()
      .then(setState)
      .catch(() => setState({ pending: [], trash: [] }));
  useEffect(() => {
    void load();
  }, []);
  const decide = async (id: string, approve: boolean) => {
    try {
      setMessage((await decideAiPending(id, approve)).message);
    } catch {
      setMessage("시간이 지났거나 처리하지 못했어요.");
    }
    await load();
    onChanged();
  };
  const restore = async (id: string) => {
    try {
      await restoreAiTrash(id);
      setMessage("되돌렸어요.");
    } catch {
      setMessage("되돌리지 못했어요.");
    }
    await load();
    onChanged();
  };
  const purge = async (id: string) => {
    try {
      await purgeAiTrash(id);
      setMessage("영구 삭제했어요.");
    } catch {
      setMessage("영구 삭제하지 못했어요.");
    }
    setPurging(null);
    setOpened(null);
    await load();
  };
  if (state === null) return null;
  return (
    <>
      {show === "pending" && state.pending.length > 0 && (
        <>
          <div className="todo-alerts-head todo-alerts-sub">
            <strong>승인 기다리는 요청</strong>
          </div>
          <p className="todo-setting-help">
            친구에 관한 일이나 공개 범위를 넓히는 일은 여기서 한 번 더 승인해야 적용돼요.
          </p>
          <ul className="todo-news">
            {state.pending.map((item) => (
              <li key={item.id} className="todo-ai-item todo-ai-request">
                <span className="todo-news-title">{item.client}</span>
                <span className="todo-ai-summary">{item.summary}</span>
                <span className="todo-ai-confirm">
                  <button type="button" className="todo-small-button" onClick={() => void decide(item.id, false)}>
                    거절
                  </button>
                  <button
                    type="button"
                    className="todo-small-button todo-primary"
                    onClick={() => void decide(item.id, true)}
                  >
                    승인
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {show === "trash" && state.trash.length === 0 && <p className="todo-setting-help">휴지통이 비어 있어요.</p>}
      {show === "trash" && state.trash.length > 0 && (
        <>
          <p className="todo-setting-help">
            삭제한 TODO, 반복, 카테고리, 친구 그룹은 7일 동안 여기서 되돌릴 수 있어요. 7일이 지나면 완전히 지워져요.
          </p>
          <ul className="todo-news">
            {state.trash.map((item) => {
              const open = opened === item.id;
              return (
                <li key={item.id} className="todo-trash-item">
                  <div className="todo-trash-line">
                    <button
                      type="button"
                      className="todo-trash-toggle"
                      aria-expanded={open}
                      onClick={() => setOpened(open ? null : item.id)}
                    >
                      <span className="todo-trash-name">{item.title}</span>
                      <span className="todo-trash-when">
                        {dateWithWeekday(localDay(item.deleted_at))} 삭제 |{" "}
                        {item.client ? `${item.client}가 삭제` : "직접 삭제"}
                      </span>
                    </button>
                    <svg
                      className={open ? "todo-trash-chevron todo-trash-chevron-open" : "todo-trash-chevron"}
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                    <button type="button" className="todo-small-button" onClick={() => void restore(item.id)}>
                      되돌리기
                    </button>
                  </div>
                  {open && (
                    <div className="todo-trash-details">
                      {(item.details ?? []).map((part, index) => (
                        <div key={index} className="todo-trash-part">
                          {part.head && <strong>{part.head}</strong>}
                          <ul>
                            {part.rows.map((row, rowIndex) => (
                              <li key={rowIndex}>{row}</li>
                            ))}
                          </ul>
                        </div>
                      ))}
                      {/* 단추 배치 규칙: 위험한 것은 왼쪽 빨간 글자 */}
                      {purging === item.id ? (
                        <div className="todo-trash-confirm">
                          <span>영구 삭제하면 다시 되돌릴 수 없어요.</span>
                          <span className="todo-trash-confirm-buttons">
                            <button type="button" className="todo-small-button" onClick={() => setPurging(null)}>
                              취소
                            </button>
                            <button
                              type="button"
                              className="todo-small-button todo-danger"
                              onClick={() => void purge(item.id)}
                            >
                              영구 삭제
                            </button>
                          </span>
                        </div>
                      ) : (
                        <div className="todo-trash-actions">
                          <button
                            type="button"
                            className="todo-text-button todo-danger-text"
                            onClick={() => setPurging(item.id)}
                          >
                            영구 삭제
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {message && (
        <p className="todo-setting-help" role="status">
          {message}
        </p>
      )}
    </>
  );
}

export default function TodoAiPanel({ onChanged }: { onChanged: () => void }) {
  const [data, setData] = useState<{
    connections: TodoConnection[];
    mcp_url: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = () =>
    fetchConnections()
      .then(setData)
      .catch(() => setError("불러오지 못했어요."));
  useEffect(() => {
    void load();
  }, []);

  const copy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.mcp_url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("복사하지 못했어요. 주소를 길게 눌러 복사해 주세요.");
    }
  };

  const cut = async (id: string) => {
    try {
      await disconnectAi(id);
      setConfirming(null);
      await load();
    } catch {
      setError("끊지 못했어요. 다시 해 주세요.");
    }
  };

  return (
    <section className="todo-alerts todo-alerts-page" aria-label="AI 연결">
      <AiRequests
        onChanged={() => {
          onChanged();
          window.dispatchEvent(new Event(TODO_NEWS_EVENT));
        }}
      />
      <p className="todo-setting-help">
        내 Claude나 ChatGPT에 연결하면 대화로 말한 TODO를 정리해서 넣어 줘요. 넣기 전에 대화에서 먼저 보여 주고
        확인받아요.
      </p>
      {data && (
        <div className="todo-ai-url">
          <code>{data.mcp_url}</code>
          <button type="button" className="todo-small-button" onClick={() => void copy()}>
            {copied ? "복사됨" : "복사"}
          </button>
        </div>
      )}
      <div className="todo-alerts-head todo-alerts-sub">
        <strong>연결된 앱</strong>
      </div>
      {data && data.connections.length === 0 && <p className="todo-setting-help">아직 연결된 앱이 없어요.</p>}
      {data && data.connections.length > 0 && (
        <ul className="todo-ai-apps">
          {data.connections.map((connection) => (
            <li key={connection.id} className="todo-ai-app">
              <span className="todo-ai-app-text">
                <strong>{connection.name}</strong>
                <span>
                  {dayLabel(connection.created_at)} 연결 | 마지막 사용 {dayLabel(connection.last_used_at)}
                </span>
              </span>
              {confirming === connection.id ? (
                <span className="todo-ai-confirm">
                  <button type="button" className="todo-small-button" onClick={() => setConfirming(null)}>
                    취소
                  </button>
                  <button
                    type="button"
                    className="todo-small-button todo-danger"
                    onClick={() => void cut(connection.id)}
                  >
                    끊기
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="todo-small-button todo-danger-text"
                  onClick={() => setConfirming(connection.id)}
                >
                  끊기
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="todo-error">{error}</p>}
    </section>
  );
}

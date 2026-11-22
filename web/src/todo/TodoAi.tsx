// AI 연결 관리(SCR-08): 내 Claude, ChatGPT에 붙이는 방법과 연결된 앱 목록(끊기)
import { useEffect, useState } from "react";
import { disconnectAi, fetchConnections, type TodoConnection } from "./todoApi";

function dayLabel(at: number | null): string {
  if (at === null) return "아직 안 씀";
  const value = new Date(at * 1000);
  return `${value.getMonth() + 1}월 ${value.getDate()}일`;
}

export default function TodoAiPanel({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<{ connections: TodoConnection[]; mcp_url: string } | null>(null);
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
    <section className="todo-alerts" aria-label="AI 연결">
      <div className="todo-alerts-head">
        <strong>AI 연결</strong>
        <button type="button" className="todo-link-button" onClick={onClose}>
          닫기
        </button>
      </div>
      <p className="todo-setting-help">
        내 Claude나 ChatGPT에 연결하면 대화로 말한 할 일을 정리해서 넣어 줘요. 넣기 전에 대화에서 먼저 보여 주고 확인받아요.
      </p>
      {data && (
        <div className="todo-ai-url">
          <code>{data.mcp_url}</code>
          <button type="button" className="todo-small-button" onClick={() => void copy()}>
            {copied ? "복사됨" : "복사"}
          </button>
        </div>
      )}
      <div className="todo-setting">
        <span className="todo-setting-name">Claude</span>
        <div className="todo-setting-body">
          <p className="todo-setting-help">
            설정(Customize) › 커넥터 › 추가 › 사용자 지정(Custom)에서 위 주소를 넣고, 연결을 누르면 이 사이트에서 승인해요. 무료 요금제는
            사용자 지정 커넥터가 1개까지예요.
          </p>
        </div>
      </div>
      <div className="todo-setting">
        <span className="todo-setting-name">ChatGPT</span>
        <div className="todo-setting-body">
          <p className="todo-setting-help">
            설정 › 앱 › 고급 설정에서 개발자 모드를 켠 뒤 앱 만들기에 위 주소를 넣어요. 개발자 모드는 요금제에 따라 없거나 읽기만 될 수
            있어요.
          </p>
        </div>
      </div>
      <div className="todo-alerts-head todo-alerts-sub">
        <strong>연결된 앱</strong>
      </div>
      {data && data.connections.length === 0 && <p className="todo-setting-help">아직 연결된 앱이 없어요.</p>}
      {data && data.connections.length > 0 && (
        <ul className="todo-news">
          {data.connections.map((connection) => (
            <li key={connection.id} className="todo-ai-item">
              <span className="todo-news-title">{connection.name}</span>
              <span className="todo-news-time">
                {dayLabel(connection.created_at)} 연결, 마지막 사용 {dayLabel(connection.last_used_at)}
              </span>
              {confirming === connection.id ? (
                <span className="todo-ai-confirm">
                  <button type="button" className="todo-small-button" onClick={() => setConfirming(null)}>
                    취소
                  </button>
                  <button type="button" className="todo-small-button todo-danger" onClick={() => void cut(connection.id)}>
                    끊기
                  </button>
                </span>
              ) : (
                <button type="button" className="todo-small-button todo-danger-text" onClick={() => setConfirming(connection.id)}>
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

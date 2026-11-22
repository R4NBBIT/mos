// AI 연결 관리(SCR-08): 내 Claude, ChatGPT에 붙이는 방법과 연결된 앱 목록(끊기)
import { useEffect, useState } from "react";
import { dateWithWeekday } from "./dates";
import {
  decideAiPending,
  disconnectAi,
  fetchAiState,
  fetchConnections,
  restoreAiTrash,
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

/** AI가 만든 요청 중 ㅁㅇㅅ에서 승인해야 하는 것, AI가 지운 할 일(7일) */
function AiRequests({ onChanged }: { onChanged: () => void }) {
  const [state, setState] = useState<{ pending: TodoAiPending[]; trash: TodoAiTrash[] } | null>(null);
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
  if (state === null) return null;
  return (
    <>
      {state.pending.length > 0 && (
        <>
          <div className="todo-alerts-head todo-alerts-sub">
            <strong>승인 기다리는 요청</strong>
          </div>
          <p className="todo-setting-help">공개 범위를 넓히는 일은 여기서 한 번 더 승인해야 적용돼요.</p>
          <ul className="todo-news">
            {state.pending.map((item) => (
              <li key={item.id} className="todo-ai-item todo-ai-request">
                <span className="todo-news-title">{item.client}</span>
                <span className="todo-ai-summary">{item.summary}</span>
                <span className="todo-ai-confirm">
                  <button type="button" className="todo-small-button" onClick={() => void decide(item.id, false)}>
                    거절
                  </button>
                  <button type="button" className="todo-small-button todo-primary" onClick={() => void decide(item.id, true)}>
                    승인
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {state.trash.length > 0 && (
        <>
          <div className="todo-alerts-head todo-alerts-sub">
            <strong>AI가 지운 할 일</strong>
          </div>
          <p className="todo-setting-help">7일 동안 되돌릴 수 있어요.</p>
          <ul className="todo-news">
            {state.trash.map((item) => (
              <li key={item.id} className="todo-ai-item">
                <span className="todo-news-title">{item.title}</span>
                <span className="todo-news-time">
                  {dateWithWeekday(item.day)}, {item.client}
                </span>
                <button type="button" className="todo-small-button" onClick={() => void restore(item.id)}>
                  되돌리기
                </button>
              </li>
            ))}
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

export default function TodoAiPanel({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
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
      <AiRequests
        onChanged={() => {
          onChanged();
          window.dispatchEvent(new Event(TODO_NEWS_EVENT));
        }}
      />
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
            데스크톱 앱: 설정 › MCP servers › Add server에서 Streamable HTTP를 고르고 위 주소를 넣은 뒤 Restart, 목록에서 Authenticate를
            누르면 이 사이트에서 승인해요.
          </p>
          <p className="todo-setting-help">웹: Plugins › + › Add custom MCP server(요금제에 따라 메뉴가 없을 수 있어요).</p>
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

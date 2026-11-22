// TODO 반응(T4, REACT): 이모지 칩(누르면 내 반응 켜고 끄기) + 반응 고르기(유니코드, 내가 쓸 수 있는 디스코드 이모지)
import { lazy, Suspense, useState } from "react";
import { viaServer } from "../format";
import { fetchTodoEmojis, reactTodo, type TodoReaction, todoErrorText } from "./todoApi";

const EmojiPicker = lazy(() => import("../EmojiPicker"));
const CUSTOM = /^<(a?):([A-Za-z0-9_]{1,32}):(\d{15,21})>$/;
const loadCustom = () => fetchTodoEmojis();

export function EmojiFace({ emoji }: { emoji: string }) {
  const custom = CUSTOM.exec(emoji);
  if (custom?.[3]) {
    const src = viaServer(
      `https://cdn.discordapp.com/emojis/${custom[3]}.webp?size=48${custom[1] === "a" ? "&animated=true" : ""}`,
    );
    return <img className="todo-react-img" src={src} alt={`:${custom[2]}:`} loading="lazy" referrerPolicy="no-referrer" />;
  }
  return <span className="todo-react-char">{emoji}</span>;
}

export function TodoReactions({
  owner,
  itemId,
  reactions,
  canAdd,
  onChange,
}: {
  /** 남의 TODO가면 주인 계정 ID, 내 것이면 null */
  owner: string | null;
  itemId: string;
  reactions: TodoReaction[];
  /** '반응 달기' 단추를 보일지(친구 TODO) */
  canAdd: boolean;
  onChange: (reactions: TodoReaction[]) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");
  const toggle = async (emoji: string, on: boolean) => {
    setError("");
    try {
      onChange((await reactTodo(owner, itemId, emoji, on)).reactions);
    } catch (failure) {
      setError(todoErrorText(failure));
    }
  };
  if (reactions.length === 0 && !canAdd) return null;
  return (
    <div className="todo-reactions">
      {reactions.map((reaction) => (
        <button
          key={reaction.emoji}
          type="button"
          className={reaction.mine ? "todo-react todo-react-mine" : "todo-react"}
          aria-pressed={reaction.mine}
          aria-label={`${reaction.emoji} ${reaction.count}명${reaction.mine ? ", 내 반응 빼기" : ", 나도 반응"}`}
          onClick={() => void toggle(reaction.emoji, !reaction.mine)}
        >
          <EmojiFace emoji={reaction.emoji} />
          <span className="todo-react-count">{reaction.count}</span>
        </button>
      ))}
      {canAdd && (
        <button type="button" className="todo-react todo-react-add" aria-label="반응 달기" onClick={() => setPicking(true)}>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="9" cy="10" r="6.5" />
            <path d="M6.5 11.5c.7 1 1.5 1.5 2.5 1.5s1.8-.5 2.5-1.5M7 8h.01M11 8h.01M16 2.5v4M14 4.5h4" />
          </svg>
        </button>
      )}
      {picking && (
        <div className="todo-react-picker">
          <Suspense fallback={<p className="todo-setting-help">불러오는 중…</p>}>
            <EmojiPicker
              loadCustom={loadCustom}
              onPick={(value) => {
                setPicking(false);
                void toggle(value, true);
              }}
              onClose={() => setPicking(false)}
            />
          </Suspense>
        </div>
      )}
      {error && <span className="todo-error">{error}</span>}
    </div>
  );
}

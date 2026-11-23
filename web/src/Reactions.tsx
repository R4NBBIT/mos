// 메시지 반응(이모지 반응) 줄. 누르면 달거나 빼고, ＋로 새 반응을 고른다.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import EmojiPicker from "./EmojiPicker";
import { useLook } from "./lookContext";
import type { Message, Reaction } from "./types";
import { emojiImageUrl } from "./format";

const PICKER_WIDTH = 360;
const PICKER_HEIGHT = 340; // .emoji-picker 높이와 같게

/** 반응 이모지를 서버에 보낼 글자로: 사용자 이모지는 코드, 기본 이모지는 그대로 */
export function reactionCode(reaction: Reaction): string {
  const { id, name, animated } = reaction.emoji;
  return id ? `<${animated ? "a" : ""}:${name}:${id}>` : name;
}

export function ReactionEmoji({ reaction }: { reaction: Reaction }) {
  const { id, name, animated } = reaction.emoji;
  if (id && /^\d{15,21}$/.test(id)) {
    return (
      <img
        className="reaction-img"
        src={emojiImageUrl(id, 48, animated)}
        alt={`:${name}:`}
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    );
  }
  return <span className="reaction-char">{name}</span>;
}

interface Props {
  message: Message;
  myUserId: string;
  /** 없으면 보기만(반응을 달 수 없는 곳) */
  onReact?: (message: Message, emoji: string) => void;
  /** 글자만 보이는 테마: [👍 2] 모양 */
  compact?: boolean;
}

export default function Reactions({ message, myUserId, onReact, compact = false }: Props) {
  const view = useLook().settings.reactions_view;
  const list = message.reactions ?? [];
  if (list.length === 0 || view === "hidden") return null;
  if (view === "compact") {
    // 설정 '작게': 반응 수만 흐린 '+n'으로(눌러도 펼치지 않는다. 반응 달기는 메시지를 눌러 '반응')
    const total = list.reduce((sum, reaction) => sum + reaction.count, 0);
    return (
      <span className="reactions-mini" role="note" aria-label={`반응 ${total}개`}>
        +{total}
      </span>
    );
  }
  return (
    <span className={compact ? "reactions reactions-compact" : "reactions"}>
      {list.map((reaction) => {
        const mine = reaction.users.includes(myUserId);
        return (
          <button
            key={reaction.key}
            type="button"
            className={mine ? "reaction reaction-mine" : "reaction"}
            aria-pressed={mine}
            title={mine ? "누르면 내 반응을 빼요" : "누르면 같은 반응을 달아요"}
            disabled={!onReact}
            onClick={(event) => {
              event.stopPropagation();
              onReact?.(message, reactionCode(reaction));
            }}
          >
            <ReactionEmoji reaction={reaction} />
            <span className="reaction-count">{reaction.count}</span>
          </button>
        );
      })}
    </span>
  );
}

/** 메시지를 골랐을 때 '반응' 버튼 → 이모지 선택창 */
export function ReactionPickerButton({
  message,
  channelId,
  onReact,
}: {
  message: Message;
  channelId: string;
  onReact: (message: Message, emoji: string) => void;
}) {
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const open = place !== null;
  const pickerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // 바깥을 누르면 닫는다
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (pickerRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setPlace(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);
  const setOpen = (value: boolean) => {
    if (!value) setPlace(null);
  };
  // 화면 위에 떠 있게(목록 안에서 잘리지 않게): 아래 자리가 모자라면 버튼 위로 연다
  const toggle = (button: HTMLElement) => {
    if (open) {
      setPlace(null);
      return;
    }
    const rect = button.getBoundingClientRect();
    const width = Math.min(PICKER_WIDTH, window.innerWidth - 16);
    const height = Math.min(PICKER_HEIGHT, window.innerHeight * 0.5);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const below = rect.bottom + 4;
    const top = below + height <= window.innerHeight - 8 ? below : Math.max(8, rect.top - height - 4);
    setPlace({ left, top });
  };
  return (
    <>
      <button ref={buttonRef} type="button" onClick={(event) => toggle(event.currentTarget)} aria-expanded={open}>
        반응
      </button>
      {place &&
        // 메시지 버튼 줄의 글꼴·버튼 모양을 물려받지 않게 화면 맨 위에 띄운다
        createPortal(
          <div
            ref={pickerRef}
            className="reaction-picker"
            style={{ left: place.left, top: place.top }}
            onClick={(event) => event.stopPropagation()}
          >
            <EmojiPicker
              channelId={channelId}
              onPick={(emoji) => {
                setOpen(false);
                onReact(message, emoji);
              }}
              onClose={() => setOpen(false)}
            />
          </div>,
          document.body,
        )}
    </>
  );
}

import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";
import type { Message } from "./types";

const MAX_LENGTH = 2000;
// 맨 앞이 /로 시작하면(디스코드 슬래시 명령처럼 보이면) 웹에서는 실행되지 않아 한 번 더 묻는다
const SLASH_COMMAND = /^\//;
const SHOW_COUNT_FROM = 1800;

const sendErrors: Record<string, string> = {
  cannot_send: "이 채널에는 보낼 수 없어요.",
  not_found: "볼 수 없거나 지워진 메시지·채널이에요.",
  reply_not_found: "답장할 메시지를 찾을 수 없어요.",
  too_long: "너무 길어요. 2000자까지 보낼 수 있어요(답장은 인용 줄 포함).",
  empty: "내용을 입력해 주세요.",
  rate_limited: "너무 빨라요. 잠깐 뒤에 다시 보내 주세요.",
  duplicate: "보내는 중이에요.",
  bot_cannot_send: "이 채널에 보낼 권한이 없어요. 관리자에게 봇의 '웹후크 관리' 권한을 부탁해 주세요.",
  rejected: "보내지 못했어요. 내용을 확인해 주세요.",
  upstream_unavailable: "연결이 잠깐 불안정해요. 다시 보내 주세요.",
};

export function sendErrorText(caught: unknown): string {
  if (caught instanceof ApiError) {
    return sendErrors[caught.code] ?? "보내지 못했어요. 다시 보내 주세요.";
  }
  return "서버에 연결할 수 없어요. 다시 보내 주세요.";
}

function newNonce(): string {
  return crypto.randomUUID();
}

interface Props {
  canSend: boolean;
  replyTo: Message | null;
  editing: Message | null;
  onCancel: () => void;
  /** 보내기·고치기. 실패하면 던진다(입력 내용은 그대로 둔다) */
  onSubmit: (text: string, nonce: string) => Promise<void>;
}

export default function Composer({ canSend, replyTo, editing, onCancel, onSubmit }: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmSlash, setConfirmSlash] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 같은 내용을 다시 보내면(네트워크 오류 뒤 재시도) 같은 nonce → 서버가 한 번만 보낸다
  const nonceRef = useRef(newNonce());

  useEffect(() => {
    if (editing) {
      setText(editing.content);
      inputRef.current?.focus();
    }
  }, [editing]);

  useEffect(() => {
    if (replyTo) inputRef.current?.focus();
  }, [replyTo]);

  // 내용 길이에 맞춰 높이 조절(최대 높이는 CSS)
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }, [text]);

  if (!canSend) {
    return <footer className="room-footer">이 채널은 읽기만 할 수 있어요.</footer>;
  }

  const looksLikeCommand = !editing && SLASH_COMMAND.test(text);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || !text.trim()) return;
    if (looksLikeCommand && !confirmSlash) {
      setConfirmSlash(true);
      return;
    }
    setConfirmSlash(false);
    setBusy(true);
    setError("");
    try {
      await onSubmit(text, nonceRef.current);
      setText("");
      nonceRef.current = newNonce();
    } catch (caught) {
      setError(sendErrorText(caught));
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 한글 조합 중 Enter는 글자 확정이라 보내지 않는다
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    } else if (event.key === "Escape" && confirmSlash) {
      event.preventDefault();
      setConfirmSlash(false); // 입력한 내용은 그대로 둔다
    } else if (event.key === "Escape" && (editing || replyTo)) {
      event.preventDefault();
      setText(editing ? "" : text);
      onCancel();
    }
  };

  const banner = editing
    ? { label: "메시지 고치는 중", detail: "" }
    : replyTo
      ? { label: `${replyTo.author.name}에게 답장`, detail: replyTo.content.replace(/\s+/g, " ").slice(0, 60) }
      : null;

  return (
    <form className="composer" onSubmit={submit}>
      {banner && (
        <div className="composer-banner">
          <span className="composer-banner-label">↪ {banner.label}</span>
          {banner.detail && <span className="composer-banner-detail">{banner.detail}</span>}
          <button
            type="button"
            className="text-button"
            onClick={() => {
              if (editing) setText("");
              onCancel();
            }}
            aria-label="취소"
          >
            ✕
          </button>
        </div>
      )}
      {error && <p className="composer-error">{error}</p>}
      {looksLikeCommand && !confirmSlash && (
        <p className="composer-hint">슬래시 명령은 디스코드 앱에서만 실행돼요. 여기서는 글자로만 올라가요.</p>
      )}
      {looksLikeCommand && confirmSlash && (
        <div className="composer-confirm" role="alert">
          <span>명령으로 실행되지 않고 글자로 올라가요. 그대로 보낼까요?</span>
          <button type="button" className="composer-confirm-send" onClick={() => void submit()} disabled={busy}>
            그대로 보내기
          </button>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setConfirmSlash(false);
              inputRef.current?.focus();
            }}
          >
            취소
          </button>
        </div>
      )}
      <div className="composer-row">
        <textarea
          ref={inputRef}
          className="composer-input"
          rows={1}
          value={text}
          maxLength={MAX_LENGTH}
          placeholder="메시지 입력"
          aria-label="메시지 입력"
          onChange={(event) => {
            setText(event.target.value);
            setConfirmSlash(false); // 고치면 다시 묻는다
            if (!editing) nonceRef.current = newNonce(); // 내용이 바뀌면 새 메시지
          }}
          onKeyDown={onKeyDown}
        />
        <button type="submit" className="composer-send" disabled={busy || !text.trim()}>
          {editing ? "저장" : "보내기"}
        </button>
      </div>
      {text.length >= SHOW_COUNT_FROM && (
        <p className="composer-count">
          {text.length} / {MAX_LENGTH}
        </p>
      )}
    </form>
  );
}

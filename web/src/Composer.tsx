import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { ApiError } from "./api";
import EmojiPicker from "./EmojiPicker";
import { formatBytes, prepareImage } from "./imageResize";
import type { Message } from "./types";

const MAX_LENGTH = 2000;
// 맨 앞이 /로 시작하면(디스코드 슬래시 명령처럼 보이면) 웹에서는 실행되지 않아 한 번 더 묻는다
const SLASH_COMMAND = /^\//;
const SHOW_COUNT_FROM = 1800;
const MAX_FILES = 10;
const MAX_FILES_BYTES = 10 * 1024 * 1024;

const sendErrors: Record<string, string> = {
  sticker_not_allowed: "이 스티커는 쓸 수 없어요(다른 모임 스티커는 니트로가 필요해요).",
  cannot_send: "이 채널에는 보낼 수 없어요.",
  not_found: "볼 수 없거나 지워진 메시지·채널이에요.",
  reply_not_found: "답장할 메시지를 찾을 수 없어요.",
  too_long: "너무 길어요. 2000자까지 보낼 수 있어요(답장은 인용 줄 포함).",
  empty: "내용을 입력해 주세요.",
  rate_limited: "너무 빨라요. 잠깐 뒤에 다시 보내 주세요.",
  duplicate: "보내는 중이에요.",
  bot_cannot_send: "이 채널에 보낼 권한이 없어요. 관리자에게 봇의 '웹후크 관리' 권한을 부탁해 주세요.",
  rejected: "보내지 못했어요. 내용을 확인해 주세요.",
  emoji_not_allowed: "쓸 수 없는 이모지가 있어요(움직이는·다른 모임 이모지는 니트로가 필요해요).",
  too_many_files: "파일은 한 번에 10개까지 보낼 수 있어요.",
  files_too_large: "파일은 합쳐서 10MB까지 보낼 수 있어요.",
  egress_limit: "이번 달 전송량이 거의 다 차서 사진·파일 보내기를 잠시 막았어요. 글은 보낼 수 있어요.",
  upstream_unavailable: "연결이 잠깐 불안정해요. 다시 보내 주세요.",
};

export function sendErrorText(caught: unknown): string {
  if (caught instanceof ApiError) {
    return sendErrors[caught.code] ?? "보내지 못했어요. 다시 보내 주세요.";
  }
  return "서버에 연결할 수 없어요. 다시 보내 주세요.";
}

/** 클립보드 사진은 이름이 'image.png'뿐이라, 붙여넣은 시각으로 이름을 붙인다 */
export function withPastedName(file: File, index: number): File {
  if (file.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(file.name)) return file;
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const extension = (file.type.split("/")[1] ?? "png").replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "") || "png";
  return new File([file], `붙여넣은사진_${stamp}${index ? `_${index + 1}` : ""}.${extension}`, {
    type: file.type,
    lastModified: file.lastModified,
  });
}

/** 첨부 미리보기: 사진이면 작은 그림 */
function FileThumb({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file.type.startsWith("image/")) return;
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  return url ? <img className="file-chip-thumb" src={url} alt="" /> : null;
}

function newNonce(): string {
  return crypto.randomUUID();
}

interface Props {
  channelId: string;
  placeholder?: string;
  /** 보낼 수 없을 때 입력창 대신 보이는 안내 */
  readOnlyText?: string;
  canSend: boolean;
  replyTo: Message | null;
  editing: Message | null;
  onCancel: () => void;
  /** 보내기·고치기. 실패하면 던진다(입력 내용은 그대로 둔다) */
  onSubmit: (text: string, nonce: string, files: File[]) => Promise<void>;
  /** 스티커 보내기(없으면 스티커를 고를 수 없음) */
  onSticker?: (stickerId: string) => Promise<void>;
}

export default function Composer({
  channelId,
  placeholder = "메시지 입력",
  readOnlyText = "이 채널은 읽기만 할 수 있어요.",
  canSend,
  replyTo,
  editing,
  onCancel,
  onSubmit,
  onSticker,
}: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmSlash, setConfirmSlash] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  // 내용 길이에 맞춰 높이 조절. 테두리까지 더해야 한 줄일 때 스크롤바(위아래 화살표)가 안 생긴다.
  // 최대 높이(CSS max-height)를 넘을 때만 안에서 스크롤
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    const border = input.offsetHeight - input.clientHeight;
    const maxHeight = Number.parseFloat(window.getComputedStyle(input).maxHeight) || Number.POSITIVE_INFINITY;
    const wanted = input.scrollHeight + border;
    input.style.height = `${Math.min(wanted, maxHeight)}px`;
    input.style.overflowY = wanted > maxHeight ? "auto" : "hidden";
  }, [text]);

  if (!canSend) {
    return <footer className="room-footer">{readOnlyText}</footer>;
  }

  const looksLikeCommand = !editing && SLASH_COMMAND.test(text);

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

  const addFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = [...(event.target.files ?? [])];
    event.target.value = ""; // 같은 파일을 다시 고를 수 있게
    await addPicked(picked);
  };

  // 복사한 사진·파일을 입력창에 붙여넣거나 끌어다 놓으면 첨부로(카톡처럼)
  const takeFiles = (list: DataTransfer | null): File[] =>
    list ? [...list.files].map((file, index) => withPastedName(file, index)) : [];

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (editing) return;
    const pasted = takeFiles(event.clipboardData);
    if (pasted.length === 0) return; // 글자는 원래대로 붙여넣기
    event.preventDefault();
    void addPicked(pasted);
  };

  const onDrop = (event: DragEvent<HTMLFormElement>) => {
    setDragging(false);
    if (editing) return;
    const dropped = takeFiles(event.dataTransfer);
    if (dropped.length === 0) return;
    event.preventDefault();
    void addPicked(dropped);
  };

  const addPicked = async (picked: File[]) => {
    if (picked.length === 0) return;
    setError("");
    setPreparing(true);
    try {
      const prepared = await Promise.all(picked.map((file) => prepareImage(file)));
      const next = [...files, ...prepared];
      if (next.length > MAX_FILES) setError(sendErrors.too_many_files ?? "");
      setFiles(next.slice(0, MAX_FILES));
      nonceRef.current = newNonce();
    } finally {
      setPreparing(false);
    }
  };

  const insertText = (value: string) => {
    const input = inputRef.current;
    const start = input?.selectionStart ?? text.length;
    const end = input?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + value + text.slice(end);
    if (next.length > MAX_LENGTH) return;
    setText(next);
    nonceRef.current = newNonce();
    window.requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + value.length, start + value.length);
    });
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || preparing || (!text.trim() && files.length === 0)) return;
    if (totalBytes > MAX_FILES_BYTES) {
      setError(sendErrors.files_too_large ?? "");
      return;
    }
    if (looksLikeCommand && !confirmSlash) {
      setConfirmSlash(true);
      return;
    }
    setConfirmSlash(false);
    setBusy(true);
    setError("");
    try {
      await onSubmit(text, nonceRef.current, editing ? [] : files);
      setText("");
      setFiles([]);
      setPickerOpen(false);
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
    <form
      className={dragging ? "composer composer-drop" : "composer"}
      onSubmit={submit}
      onDragOver={(event) => {
        if (editing || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
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
      {pickerOpen && (
        <EmojiPicker
          channelId={channelId}
          onPick={insertText}
          onClose={() => setPickerOpen(false)}
          onPickSticker={
            onSticker && !editing
              ? (sticker) => {
                  setPickerOpen(false);
                  setError("");
                  onSticker(sticker.id).catch((caught: unknown) => setError(sendErrorText(caught)));
                }
              : undefined
          }
        />
      )}
      {files.length > 0 && (
        <div className="composer-files">
          {files.map((file, index) => (
            <span key={`${file.name}-${index}`} className="file-chip">
              <FileThumb file={file} />
              <span className="file-chip-name">{file.name}</span>
              <span className="file-chip-size">{formatBytes(file.size)}</span>
              <button
                type="button"
                aria-label={`${file.name} 빼기`}
                onClick={() => {
                  setFiles(files.filter((_, i) => i !== index));
                  nonceRef.current = newNonce();
                }}
              >
                ✕
              </button>
            </span>
          ))}
          <span className={totalBytes > MAX_FILES_BYTES ? "composer-error" : "file-total"}>
            합계 {formatBytes(totalBytes)} / 10MB
          </span>
        </div>
      )}
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
        {!editing && (
          <>
            <button
              type="button"
              className="composer-icon"
              onClick={() => fileInputRef.current?.click()}
              aria-label="사진·파일 붙이기"
              title="사진·파일 붙이기"
              disabled={preparing}
            >
              {preparing ? "…" : <IconPlus />}
            </button>
            <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => void addFiles(event)} />
          </>
        )}
        <button
          type="button"
          className={pickerOpen ? "composer-icon composer-icon-on" : "composer-icon"}
          onClick={() => setPickerOpen((open) => !open)}
          aria-label="이모지"
          title="이모지"
        >
          <IconSmile />
        </button>
        <textarea
          ref={inputRef}
          className="composer-input"
          rows={1}
          value={text}
          maxLength={MAX_LENGTH}
          placeholder={placeholder}
          aria-label="메시지 입력"
          onChange={(event) => {
            setText(event.target.value);
            setConfirmSlash(false); // 고치면 다시 묻는다
            if (!editing) nonceRef.current = newNonce(); // 내용이 바뀌면 새 메시지
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <button
          type="submit"
          className="composer-send"
          disabled={busy || preparing || (!text.trim() && files.length === 0)}
        >
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

function IconPlus() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function IconSmile() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M8.5 14.5c.9 1.2 2.1 1.8 3.5 1.8s2.6-.6 3.5-1.8" />
      </g>
      <circle cx="9" cy="10" r="1.2" fill="currentColor" />
      <circle cx="15" cy="10" r="1.2" fill="currentColor" />
    </svg>
  );
}

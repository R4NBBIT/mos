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
import { ApiError, type BotCommand, type BotCommandResult, fetchBotCommands, rerollMenu, runBotCommand } from "./api";
import EmojiPicker from "./EmojiPicker";
import { formatBytes, prepareImage } from "./imageResize";
import { Avatar } from "./MessageItem";
import { applyMentions, filterItems, findTrigger, loadMentionData, type MentionItem } from "./mentions";
import type { Message } from "./types";

const MAX_LENGTH = 2000;
// 맨 앞이 /로 시작하면(디스코드 슬래시 명령처럼 보이면) 웹에서는 실행되지 않아 한 번 더 묻는다
const SLASH_COMMAND = /^\//;
const SHOW_COUNT_FROM = 1800;
const MAX_FILES = 10;
const MAX_FILES_BYTES = 10 * 1024 * 1024;

const sendErrors: Record<string, string> = {
  sticker_not_allowed: "이 스티커는 쓸 수 없어요(다른 서버 스티커는 니트로가 필요해요).",
  cannot_send: "이 채널에는 보낼 수 없어요.",
  not_found: "볼 수 없거나 지워진 메시지나 채널이에요.",
  reply_not_found: "답장할 메시지를 찾을 수 없어요.",
  too_long: "너무 길어요. 2000자까지 보낼 수 있어요(답장은 인용 줄 포함).",
  empty: "내용을 입력해 주세요.",
  rate_limited: "너무 빨라요. 잠깐 뒤에 다시 보내 주세요.",
  duplicate: "보내는 중이에요.",
  bot_cannot_send: "이 채널에 보낼 권한이 없어요. 관리자에게 봇의 '웹후크 관리' 권한을 부탁해 주세요.",
  rejected: "보내지 못했어요. 내용을 확인해 주세요.",
  emoji_not_allowed: "쓸 수 없는 이모지가 있어요(움직이는 이모지와 다른 서버 이모지는 니트로가 필요해요).",
  too_many_files: "파일은 한 번에 10개까지 보낼 수 있어요.",
  files_too_large: "파일은 합쳐서 10MB까지 보낼 수 있어요.",
  egress_limit: "이번 달 전송량이 거의 다 차서 사진과 파일 보내기를 잠시 막았어요. 글은 보낼 수 있어요.",
  upstream_unavailable: "연결이 잠깐 불안정해요. 다시 보내 주세요.",
  slowmode: "슬로우 모드가 걸린 채널이라 조금 기다렸다가 보낼 수 있어요.",
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

// 쓰다 만 글: 채널마다 이 브라우저에 남겨 두고(다른 채널, 잠금, 새로고침 뒤에도), 보내면 지운다
interface Draft {
  text: string;
  /** '@이름' → 사람 ID, '#채널' → 채널 ID(보낼 때 멘션으로 바꾸려고) */
  picked: Record<string, string>;
}

const draftKey = (channelId: string) => `mos.draft.${channelId}`;

function readDraft(channelId: string): Draft {
  try {
    const value = JSON.parse(localStorage.getItem(draftKey(channelId)) ?? "null") as Partial<Draft> | null;
    if (!value || typeof value.text !== "string") return { text: "", picked: {} };
    const picked: Record<string, string> = {};
    for (const [token, id] of Object.entries(value.picked ?? {})) {
      if (typeof id === "string" && /^\d{1,21}$/.test(id)) picked[token] = id;
    }
    return { text: value.text.slice(0, MAX_LENGTH), picked };
  } catch {
    return { text: "", picked: {} };
  }
}

function writeDraft(channelId: string, draft: Draft): void {
  try {
    if (draft.text.trim()) localStorage.setItem(draftKey(channelId), JSON.stringify(draft));
    else localStorage.removeItem(draftKey(channelId));
  } catch {
    // 남기지 못해도 지금 쓰는 데는 지장 없다
  }
}

/** 붙인 파일: 사진이면 줄인 것(prepared)과 원본을 둘 다 가지고 있다가 고른 쪽을 보낸다 */
interface PickedFile {
  original: File;
  prepared: File;
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
  /** @사람, #채널 자동완성에 쓸 서버와, 볼 수 있는 사람을 가릴 채널(스레드면 부모) */
  groupId?: string;
  viewChannelId?: string;
  /** 나에게 걸리는 슬로우 모드(초) */
  slowmode?: number;
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
  groupId,
  viewChannelId,
  slowmode = 0,
}: Props) {
  const [text, setText] = useState(() => readDraft(channelId).text);
  const pickedRef = useRef<Record<string, string>>(readDraft(channelId).picked);
  const [suggest, setSuggest] = useState<{ kind: "@" | "#"; start: number; items: MentionItem[]; index: number } | null>(
    null,
  );
  const [sendOriginal, setSendOriginal] = useState(false);
  // 슬로우 모드: 이때까지는 보내기를 막고 남은 초를 보여 준다
  const [coolUntil, setCoolUntil] = useState(0);
  const [, setTick] = useState(0);
  const coolLeft = Math.max(0, Math.ceil((coolUntil - Date.now()) / 1000));
  useEffect(() => {
    if (coolUntil <= Date.now()) return;
    const timer = window.setInterval(() => {
      setTick((value) => value + 1);
      if (Date.now() >= coolUntil) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [coolUntil]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmSlash, setConfirmSlash] = useState(false);
  // ㅁㅇㅅ 봇 명령(/점메추, /메뉴판, /todo …): 메시지로 보내지 않고 실행, 결과는 나에게만
  const [botCommands, setBotCommands] = useState<BotCommand[]>([]);
  const [commandResult, setCommandResult] = useState<(BotCommandResult & { until: number }) | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  useEffect(() => {
    let stopped = false;
    void fetchBotCommands().then((list) => !stopped && setBotCommands(list));
    return () => {
      stopped = true;
    };
  }, []);
  const [items, setItems] = useState<PickedFile[]>([]);
  const files = items.map((item) => (sendOriginal ? item.original : item.prepared));
  const shrunk = items.some((item) => item.prepared !== item.original);
  const [preparing, setPreparing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 같은 내용을 다시 보내면(네트워크 오류 뒤 재시도) 같은 nonce → 서버가 한 번만 보낸다
  const nonceRef = useRef(newNonce());

  // 고치기를 시작하면 그 메시지 내용으로, 끝나면 쓰다 만 글로 되돌린다
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editing) {
      wasEditing.current = true;
      setText(editing.content);
      inputRef.current?.focus();
    } else if (wasEditing.current) {
      wasEditing.current = false;
      const draft = readDraft(channelId);
      pickedRef.current = draft.picked;
      setText(draft.text);
    }
  }, [editing, channelId]);

  useEffect(() => {
    if (replyTo) inputRef.current?.focus();
  }, [replyTo]);

  // 쓰다 만 글 남기기(고치는 중인 메시지는 남기지 않는다)
  useEffect(() => {
    if (editing) return;
    const timer = window.setTimeout(() => writeDraft(channelId, { text, picked: pickedRef.current }), 300);
    return () => window.clearTimeout(timer);
  }, [text, channelId, editing]);

  // @, # 뒤에 글자를 치면 고를 목록
  const updateSuggest = async (value: string, caret: number) => {
    const trigger = groupId ? findTrigger(value, caret) : null;
    if (!trigger || !groupId) {
      setSuggest(null);
      return;
    }
    const data = await loadMentionData(groupId);
    let pool = trigger.kind === "#" ? data.channels : data.people;
    const allowed = trigger.kind === "@" && viewChannelId ? data.restricted[viewChannelId] : undefined;
    if (allowed) pool = pool.filter((item) => allowed.includes(item.id));
    const found = filterItems(pool, trigger.query);
    // 그 사이 글자가 또 바뀌었으면 버린다
    const now = inputRef.current;
    if (!now || now.value !== value) return;
    setSuggest(found.length ? { kind: trigger.kind, start: trigger.start, items: found, index: 0 } : null);
  };

  const pickSuggest = (item: MentionItem) => {
    const input = inputRef.current;
    if (!input || !suggest) return;
    const caret = input.selectionStart ?? text.length;
    const token = `${item.kind}${item.name.replace(/\s+/g, "_")}`;
    const next = `${text.slice(0, suggest.start)}${token} ${text.slice(caret)}`;
    if (next.length > MAX_LENGTH) return;
    pickedRef.current = { ...pickedRef.current, [token]: item.id };
    setText(next);
    setSuggest(null);
    nonceRef.current = newNonce();
    const at = suggest.start + token.length + 1;
    window.requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(at, at);
    });
  };

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

  const commandHead = text.trim().split(/\s+/)[0] ?? "";
  const isBotCommand =
    !editing && botCommands.some((command) => `/${command.name.split(" ")[0]}`.toLowerCase() === commandHead.toLowerCase());
  const looksLikeCommand = !editing && SLASH_COMMAND.test(text) && !isBotCommand;
  // '/'만 쓰는 중이면 쓸 수 있는 봇 명령을 보여 준다
  const commandChoices =
    !editing && /^\/[^\n]*$/.test(text) && text.split(" ").length <= 2
      ? botCommands.filter((command) => `/${command.name}`.startsWith(text.trimEnd()) && `/${command.name}` !== text.trimEnd())
      : [];
  const pickCommand = (command: BotCommand) => {
    setText(`/${command.name} `);
    setCommandIndex(0);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  };
  const runCommand = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await runBotCommand(channelId, text.trim());
      setCommandResult({ ...result, until: Date.now() + 30_000 });
      setText("");
      writeDraft(channelId, { text: "", picked: {} });
    } catch (caught) {
      setError(caught instanceof ApiError && caught.code === "cannot_send" ? "이 채널에는 올릴 수 없어요." : "명령을 실행하지 못했어요.");
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

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
      const prepared = await Promise.all(
        picked.map(async (file) => ({ original: file, prepared: await prepareImage(file) })),
      );
      const next = [...items, ...prepared];
      if (next.length > MAX_FILES) setError(sendErrors.too_many_files ?? "");
      setItems(next.slice(0, MAX_FILES));
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
    if (!editing && coolLeft > 0) return;
    if (totalBytes > MAX_FILES_BYTES) {
      setError(sendErrors.files_too_large ?? "");
      return;
    }
    if (isBotCommand) {
      await runCommand();
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
      await onSubmit(applyMentions(text, pickedRef.current), nonceRef.current, editing ? [] : files);
      setText("");
      setItems([]);
      setSendOriginal(false);
      if (!editing && slowmode > 0) setCoolUntil(Date.now() + slowmode * 1000);
      if (!editing) {
        pickedRef.current = {};
        writeDraft(channelId, { text: "", picked: {} });
      }
      setPickerOpen(false);
      nonceRef.current = newNonce();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "slowmode") {
        setCoolUntil(Date.now() + (caught.retryAfter ?? slowmode) * 1000);
        setError("");
      } else {
        setError(sendErrorText(caught));
      }
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 한글 조합 중 Enter는 글자 확정이라 보내지 않는다
    if (event.nativeEvent.isComposing) return;
    if (commandChoices.length > 0 && !suggest) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setCommandIndex((commandIndex + step + commandChoices.length) % commandChoices.length);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !isBotCommand)) {
        event.preventDefault();
        const choice = commandChoices[Math.min(commandIndex, commandChoices.length - 1)];
        if (choice) pickCommand(choice);
        return;
      }
    }
    if (suggest) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setSuggest({ ...suggest, index: (suggest.index + step + suggest.items.length) % suggest.items.length });
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const item = suggest.items[suggest.index];
        if (item) pickSuggest(item);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSuggest(null);
        return;
      }
    }
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
      {suggest && (
        <ul className="mention-list" role="listbox" aria-label={suggest.kind === "@" ? "사람 고르기" : "채널 고르기"}>
          {suggest.items.map((item, index) => (
            <li key={`${item.kind}${item.id}`} role="option" aria-selected={index === suggest.index}>
              <button
                type="button"
                className={index === suggest.index ? "mention-item mention-item-on" : "mention-item"}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pickSuggest(item)}
              >
                {item.kind === "@" ? (
                  <Avatar url={item.avatar ?? null} name={item.name} />
                ) : (
                  <span className="mention-hash" aria-hidden="true">
                    #
                  </span>
                )}
                <span className="mention-name">{item.name}</span>
                {item.bot && <span className="member-bot">봇</span>}
              </button>
            </li>
          ))}
        </ul>
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
                  setItems(items.filter((_, i) => i !== index));
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
          {shrunk && (
            <div className="photo-note">
              <label className="photo-original">
                <input
                  type="checkbox"
                  checked={sendOriginal}
                  onChange={(event) => {
                    setSendOriginal(event.target.checked);
                    nonceRef.current = newNonce();
                  }}
                />
                원본으로 보내기
              </label>
              <span className="photo-why">
                사진은 화질은 거의 그대로 두고 크기만 줄여 보내요. 한 번에 10MB까지만 보낼 수 있고, 이 사이트가 한 달에
                보낼 수 있는 양도 아낄 수 있어요. 위치 같은 사진 속 기록도 함께 지워져요.
              </span>
            </div>
          )}
        </div>
      )}
      {commandChoices.length > 0 && !suggest && (
        <ul className="mention-list command-list" role="listbox" aria-label="봇 명령">
          {commandChoices.map((command, index) => (
            <li key={command.name} role="option" aria-selected={index === commandIndex}>
              <button
                type="button"
                className={index === commandIndex ? "mention-item mention-item-on" : "mention-item"}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pickCommand(command)}
              >
                <span className="command-usage">{command.usage}</span>
                <span className="command-help">{command.help}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {commandResult && (
        <div className="command-result" role="status">
          <div className="command-result-head">
            <span className="command-result-tag">나만 보여요</span>
            <button type="button" className="text-button" aria-label="닫기" onClick={() => setCommandResult(null)}>
              ✕
            </button>
          </div>
          <p className="command-result-text">{commandResult.text.replace(/\*\*/g, "")}</p>
          {commandResult.choices && commandResult.choices.length > 0 && (
            <div className="command-choices">
              {commandResult.choices.map((choice) => (
                <button
                  key={choice.label}
                  type="button"
                  className="pill-button"
                  onClick={() =>
                    void runBotCommand(channelId, choice.text)
                      .then((result) => setCommandResult({ ...result, until: Date.now() + 30_000 }))
                      .catch(() => setError("명령을 실행하지 못했어요."))
                  }
                >
                  {choice.label}
                </button>
              ))}
            </div>
          )}
          {commandResult.session && Date.now() < commandResult.until && (
            <button
              type="button"
              className="pill-button"
              onClick={() =>
                void rerollMenu(commandResult.session ?? "")
                  .then((result) => setCommandResult({ ...result, until: Date.now() + 30_000 }))
                  .catch(() => setError("다시 뽑지 못했어요."))
              }
            >
              🎲 리롤
            </button>
          )}
        </div>
      )}
      {looksLikeCommand && !confirmSlash && commandChoices.length === 0 && (
        <p className="composer-hint">이 슬래시 명령은 디스코드 앱에서만 실행돼요. 여기서는 글자로만 올라가요. ㅁㅇㅅ 봇 명령은 / 를 쓰면 목록이 나와요.</p>
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
              aria-label="사진, 파일 붙이기"
              title="사진, 파일 붙이기"
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
            void updateSuggest(event.target.value, event.target.selectionStart ?? event.target.value.length);
          }}
          onBlur={() => window.setTimeout(() => setSuggest(null), 150)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <button
          type="submit"
          className="composer-send"
          disabled={busy || preparing || (!text.trim() && files.length === 0) || (!editing && coolLeft > 0)}
        >
          {editing ? "저장" : coolLeft > 0 ? `${coolLeft}초` : "보내기"}
        </button>
      </div>
      {!editing && coolLeft > 0 && (
        <p className="composer-hint" role="status">
          슬로우 모드: {slowmode || coolLeft}초에 한 번 보낼 수 있어요. {coolLeft}초 뒤에 보낼 수 있어요.
        </p>
      )}
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

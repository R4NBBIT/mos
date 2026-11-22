import BackIcon from "./BackIcon";
import SplitToggle from "./SplitToggle";
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, createPost, fetchThreads } from "./api";
import { sendErrorText, withPastedName } from "./Composer";
import { formatDay, formatTime } from "./format";
import { formatBytes, prepareImage } from "./imageResize";
import EditableText from "./EditableText";
import { useLook } from "./lookContext";
import { SheetFrame } from "./SheetView";
import type { Theme } from "./theme";
import type { ChannelInfo, ForumTag, ThreadPage, ThreadSummary } from "./types";
import { useRealtime } from "./useRealtime";

const REFRESH_DELAY_MS = 1500; // 댓글이 몰려도 한 번만 다시 받는다

const MAX_TAGS = 5;

const postErrors: Record<string, string> = {
  tag_required: "이 포럼은 태그를 하나 이상 골라야 해요.",
  bad_tags: "고를 수 없는 태그가 있어요.",
  tag_not_allowed: "관리자만 붙일 수 있는 태그예요.",
  bad_title: "제목을 입력해 주세요(100자까지).",
};

function errorText(caught: unknown): string {
  if (caught instanceof ApiError && postErrors[caught.code]) return postErrors[caught.code] ?? "";
  return sendErrorText(caught);
}

function when(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  return date.toDateString() === today.toDateString() ? formatTime(iso) : formatDay(iso).replace(/ \S+요일$/, "");
}

/** 시트 셀용 짧은 날짜: 오늘이면 14:05, 아니면 2026-11-20 */
function cellWhen(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  if (date.toDateString() === new Date().toDateString()) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function TagChip({ tag, active, onClick }: { tag: ForumTag; active?: boolean; onClick?: () => void }) {
  const label = `${tag.emoji ? `${tag.emoji} ` : ""}${tag.name}`;
  if (!onClick) return <span className="tag-chip">{label}</span>;
  return (
    <button
      type="button"
      className={active ? "tag-chip tag-chip-on" : "tag-chip"}
      onClick={onClick}
      disabled={!tag.usable && !active}
      title={tag.usable ? undefined : "관리자만 붙일 수 있는 태그예요"}
    >
      {label}
    </button>
  );
}

function NewPost({
  forum,
  onCreated,
  onCancel,
}: {
  forum: ChannelInfo;
  onCreated: (threadId: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [nonce] = useState(() => crypto.randomUUID());

  const addFiles = (picked: File[]) => {
    void Promise.all(picked.map((file) => prepareImage(file))).then((prepared) =>
      setFiles((current) => [...current, ...prepared].slice(0, 10)),
    );
  };

  const toggle = (id: string) => {
    setError("");
    setTags((current) =>
      current.includes(id) ? current.filter((tag) => tag !== id) : current.length < MAX_TAGS ? [...current, id] : current,
    );
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !title.trim()) return;
    if (forum.require_tag && tags.length === 0) {
      setError(postErrors.tag_required ?? "");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const created = await createPost(forum.id, title, content, tags, nonce, files);
      onCreated(created.thread_id);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="new-post" onSubmit={submit}>
      <input
        className="new-post-title"
        value={title}
        maxLength={100}
        placeholder="제목"
        aria-label="제목"
        onChange={(event) => setTitle(event.target.value)}
        autoFocus
      />
      {(forum.tags?.length ?? 0) > 0 && (
        <div className="tag-row">
          <span className="tag-row-label">태그{forum.require_tag ? "(필수)" : ""}</span>
          {forum.tags?.map((tag) => (
            <TagChip key={tag.id} tag={tag} active={tags.includes(tag.id)} onClick={() => toggle(tag.id)} />
          ))}
        </div>
      )}
      <textarea
        className="new-post-content"
        value={content}
        maxLength={2000}
        placeholder="내용"
        aria-label="내용"
        onChange={(event) => setContent(event.target.value)}
        onPaste={(event) => {
          // 복사한 사진을 붙여넣으면 첨부로
          const pasted = [...event.clipboardData.files].map((file, index) => withPastedName(file, index));
          if (pasted.length === 0) return;
          event.preventDefault();
          addFiles(pasted);
        }}
      />
      <div className="new-post-actions">
        <label className="text-button file-pick">
          사진, 파일 붙이기
          <input
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const picked = [...(event.target.files ?? [])];
              event.target.value = "";
              addFiles(picked);
            }}
          />
        </label>
        {files.length > 0 && (
          <span className="file-total">
            파일 {files.length}개, {formatBytes(files.reduce((sum, file) => sum + file.size, 0))}
          </span>
        )}
        <span className="spacer" />
        <button type="button" className="text-button" onClick={onCancel}>
          취소
        </button>
        <button type="submit" className="composer-send" disabled={busy || !title.trim()}>
          {busy ? "올리는 중…" : "올리기"}
        </button>
      </div>
      {error && <p className="composer-error">{error}</p>}
    </form>
  );
}

interface Props {
  parentId: string;
  /** 넓은 화면이면 목록이 왼쪽에 있어 뒤로 버튼을 숨긴다 */
  showBack: boolean;
  menu: ReactNode | null;
  onBack: (parent: ChannelInfo | null) => void;
  onOpen: (threadId: string) => void;
  onAuthLost: () => void;
  /** 시트 테마면 글 목록도 표로 */
  theme?: Theme;
  /** 시트 탭에서 다른 채널 열기 */
  onOpenChannel?: (channel: ChannelInfo) => void;
}

/** 포럼 글 목록, 또는 일반 채널의 스레드 목록 */
export default function Posts({
  parentId,
  showBack,
  menu,
  onBack,
  onOpen,
  onAuthLost,
  theme = "moon",
  onOpenChannel,
}: Props) {
  const [page, setPage] = useState<ThreadPage | null>(null);
  const {
    settings: { doc_titles: docTitles },
    save: saveLook,
  } = useLook();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [error, setError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [pointed, setPointed] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    setPage(null);
    setThreads([]);
    setError("");
    fetchThreads(parentId, null)
      .then((body) => {
        if (stopped) return;
        setPage(body);
        setThreads(body.threads);
      })
      .catch((caught: unknown) => {
        if (stopped) return;
        if (caught instanceof ApiError && caught.status === 401) onAuthLost();
        else if (caught instanceof ApiError && caught.status === 404) setError("볼 수 없는 채널이에요.");
        else setError("목록을 불러오지 못했어요. 잠시 후 다시 열어 주세요.");
      });
    return () => {
      stopped = true;
    };
  }, [parentId, onAuthLost]);

  // 실시간: 글이 생기거나 바뀌거나 댓글이 달리면 첫 쪽을 다시 받아 합친다(더 불러온 지난 글은 그대로)
  const moreLoaded = useRef(false);
  const connectedOnce = useRef(false);
  const refreshTimer = useRef<number | undefined>(undefined);
  const refresh = useCallback(() => {
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      fetchThreads(parentId, null)
        .then((body) => {
          const fresh = new Set(body.threads.map((thread) => thread.id));
          setThreads((current) =>
            moreLoaded.current
              ? [...body.threads, ...current.filter((thread) => thread.archived && !fresh.has(thread.id))]
              : body.threads,
          );
          setPage((current) =>
            moreLoaded.current && current ? { ...body, has_more: current.has_more, next_before: current.next_before } : body,
          );
        })
        .catch(() => {}); // 다음 변경 때 다시
    }, REFRESH_DELAY_MS);
  }, [parentId]);
  useEffect(() => {
    moreLoaded.current = false;
    return () => window.clearTimeout(refreshTimer.current);
  }, [parentId]);
  useRealtime(parentId, {
    onEvent: (event) => {
      if (event.type === "threads_changed" && event.data.channel_id === parentId) refresh();
    },
    onConnected: () => {
      if (connectedOnce.current) refresh(); // 끊긴 사이 바뀐 것
      connectedOnce.current = true;
    },
    onStatus: () => {},
    onRejected: onAuthLost,
  });

  const loadMore = async () => {
    if (!page?.next_before || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await fetchThreads(parentId, page.next_before);
      moreLoaded.current = true;
      setPage(next);
      setThreads((current) => [...current, ...next.threads.filter((t) => !current.some((c) => c.id === t.id))]);
    } catch {
      setError("더 불러오지 못했어요.");
    } finally {
      setLoadingMore(false);
    }
  };

  const parent = page?.parent ?? null;
  const isForum = parent?.kind === "forum";
  const tagsById = new Map((parent?.tags ?? []).map((tag) => [tag.id, tag]));
  const shown = filter ? threads.filter((thread) => thread.tag_ids.includes(filter)) : threads;
  const tagText = (thread: ThreadSummary) =>
    thread.tag_ids
      .map((id) => tagsById.get(id))
      .filter((tag): tag is ForumTag => Boolean(tag))
      .map((tag) => `${tag.emoji ? `${tag.emoji} ` : ""}${tag.name}`)
      .join(", ");

  if (theme === "sheet") {
    // 글 = 행. A 제목, B 태그, C 첫 글 미리보기, D 댓글 수, E 최근 활동, F 상태. 행을 누르면 열린다
    const pointedThread = shown.find((thread) => thread.id === pointed) ?? null;
    const pointedRow = pointedThread ? shown.indexOf(pointedThread) + 2 : shown.length + 2;
    return (
      <SheetFrame
        variant="posts"
        showBack
        onBack={() => onBack(parent)}
        menu={menu}
        menuExtra={
          isForum && parent?.can_post && !writing ? (
            <button type="button" className="sheet-menu sheet-menu-link" onClick={() => setWriting(true)}>
              새 글
            </button>
          ) : null
        }
        ribbon={
          isForum && (parent?.tags?.length ?? 0) > 0 ? (
            <div className="sheet-ribbon sheet-filter">
              <span className="sheet-ribbon-item">필터</span>
              {parent?.tags?.map((tag) => (
                <button
                  key={tag.id}
                  type="button"
                  className={filter === tag.id ? "sheet-ribbon-item sheet-ribbon-on" : "sheet-ribbon-item"}
                  aria-pressed={filter === tag.id}
                  onClick={() => setFilter(filter === tag.id ? null : tag.id)}
                >
                  {tag.emoji ? `${tag.emoji} ` : ""}
                  {tag.name}
                </button>
              ))}
            </div>
          ) : undefined
        }
        nameBox={`A${pointedRow}`}
        formula={pointedThread ? `${pointedThread.name}${pointedThread.preview ? ` — ${pointedThread.preview}` : ""}` : null}
        tabsChannel={parent}
        onOpenTab={onOpenChannel}
        status={
          <span>
            {page === null && !error
              ? "불러오는 중…"
              : `${isForum ? "글" : "스레드"} ${shown.length}${page?.has_more ? "+" : ""}개${filter ? " (필터)" : ""}`}
          </span>
        }
      >
        {writing && parent && (
          <div className="sheet-panel">
            <NewPost forum={parent} onCreated={onOpen} onCancel={() => setWriting(false)} />
          </div>
        )}
        <div className="sheet-row sheet-head">
          <span className="sheet-rownum">1</span>
          <span className="sheet-cell">제목</span>
          <span className="sheet-cell">태그</span>
          <span className="sheet-cell">{isForum ? "본문" : "내용"}</span>
          <span className="sheet-cell">댓글</span>
          <span className="sheet-cell sheet-wide">최근 활동</span>
          <span className="sheet-cell sheet-wide">상태</span>
        </div>
        {error && <p className="room-error">{error}</p>}
        {shown.map((thread, index) => (
          <div
            key={thread.id}
            role="button"
            tabIndex={0}
            className={thread.id === pointed ? "sheet-row sheet-row-link sheet-row-selected" : "sheet-row sheet-row-link"}
            onMouseEnter={() => setPointed(thread.id)}
            onFocus={() => setPointed(thread.id)}
            onClick={() => onOpen(thread.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onOpen(thread.id);
            }}
          >
            <span className="sheet-rownum">{index + 2}</span>
            <span className="sheet-cell sheet-cell-title">
              {thread.locked ? "🔒 " : ""}
              {thread.name}
            </span>
            <span className="sheet-cell">{tagText(thread)}</span>
            <span className="sheet-cell sheet-cell-c">{thread.preview ?? ""}</span>
            <span className="sheet-cell sheet-num">{thread.message_count}</span>
            <span className="sheet-cell sheet-wide">{cellWhen(thread.last_message_at)}</span>
            <span className="sheet-cell sheet-wide">
              {[thread.private && "비공개", thread.archived ? "보관됨" : thread.locked && "잠김"].filter(Boolean).join(", ")}
            </span>
          </div>
        ))}
        {page?.has_more && (
          <button type="button" className="sheet-older" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? "불러오는 중…" : "아래 행 더 불러오기(지난 글)"}
          </button>
        )}
      </SheetFrame>
    );
  }

  return (
    <div className="room">
      <header className="room-header">
        <SplitToggle />
        {showBack && (
          <button type="button" className="back-button" onClick={() => onBack(parent)} aria-label="뒤로">
            <BackIcon />
          </button>
        )}
        <div className="room-title">
          <strong>{parent ? `${isForum ? "▤" : "#"} ${parent.name}` : "…"}</strong>
          <span className="room-sub">{parent ? (isForum ? "글 목록" : "스레드") : ""}</span>
        </div>
        {isForum && parent?.can_post && !writing && (
          <button type="button" className="composer-send header-action" onClick={() => setWriting(true)}>
            새 글
          </button>
        )}
        {menu}
      </header>
      <div className="list-body posts-body">
        {theme === "word" && parent && (
          // Word: 글 목록도 문서처럼, 제목과 부제목은 바로 고칠 수 있다(위장용)
          <div className="wd-head">
            <EditableText
              as="h1"
              className="wd-title"
              value={docTitles[parent.id] ?? parent.name}
              fallback={parent.name}
              label="문서 제목"
              onSave={(text) => void saveLook({ doc_titles: { [parent.id]: text } })}
            />
            <EditableText
              as="p"
              className="wd-sub"
              value={docTitles[`${parent.id}:sub`] ?? (isForum ? "문서 목록" : "하위 문서")}
              fallback={isForum ? "문서 목록" : "하위 문서"}
              label="문서 부제목"
              onSave={(text) => void saveLook({ doc_titles: { [`${parent.id}:sub`]: text } })}
            />
          </div>
        )}
        {writing && parent && (
          <NewPost forum={parent} onCreated={onOpen} onCancel={() => setWriting(false)} />
        )}
        {isForum && (parent?.tags?.length ?? 0) > 0 && (
          <div className="tag-row tag-filter">
            {parent?.tags?.map((tag) => (
              <TagChip
                key={tag.id}
                tag={{ ...tag, usable: true }}
                active={filter === tag.id}
                onClick={() => setFilter(filter === tag.id ? null : tag.id)}
              />
            ))}
          </div>
        )}
        {error && <p className="list-note">{error}</p>}
        {!error && page === null && <p className="list-note">불러오는 중…</p>}
        {page && shown.length === 0 && (
          <p className="list-note">{isForum ? "글이 없어요." : "스레드가 없어요."}</p>
        )}
        {shown.map((thread) => (
          <button key={thread.id} type="button" className="post-item" onClick={() => onOpen(thread.id)}>
            <span className="post-title">
              {thread.locked && <span title="잠긴 글">🔒 </span>}
              {thread.name}
            </span>
            {thread.tag_ids.length > 0 && (
              <span className="post-tags">
                {thread.tag_ids.map((id) => {
                  const tag = tagsById.get(id);
                  return tag ? <TagChip key={id} tag={tag} /> : null;
                })}
              </span>
            )}
            {thread.preview && <span className="post-preview">{thread.preview}</span>}
            <span className="post-meta">
              <span>{theme === "word" ? `댓글 ${thread.message_count}` : `💬 ${thread.message_count}`}</span>
              <span>{when(thread.last_message_at)}</span>
              {thread.private && <span className="post-archived">비공개</span>}
              {thread.archived && <span className="post-archived">보관됨</span>}
            </span>
          </button>
        ))}
        {page?.has_more && (
          <button type="button" className="older-button" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? "불러오는 중…" : "지난 글 더 보기"}
          </button>
        )}
      </div>
    </div>
  );
}

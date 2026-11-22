// 포럼 글, 스레드의 제목과 태그 고치기(글쓴이나 스레드 관리 권한이 있는 사람). 봇에 '스레드 관리' 권한이 있어야 한다
import { useState } from "react";
import { ApiError, editPost, fetchChannel } from "./api";
import type { ChannelInfo, ForumTag } from "./types";

const errors: Record<string, string> = {
  bot_cannot_manage_threads:
    "봇에 '스레드 관리' 권한이 없어서 고칠 수 없어요. 서버 관리자에게 서버 설정 › 역할 › ㅁㅇㅅ에서 '스레드 관리'를 켜 달라고 해 주세요.",
  cannot_edit_post: "글을 쓴 사람이나 스레드 관리 권한이 있는 사람만 고칠 수 있어요.",
  tag_required: "이 포럼은 태그를 하나 이상 골라야 해요.",
  tag_not_allowed: "관리자 전용 태그는 고를 수 없어요.",
  bad_title: "제목은 1~100자로 써 주세요.",
  bad_tags: "태그는 5개까지 고를 수 있어요.",
};

export default function PostEditor({
  channel,
  onSaved,
}: {
  channel: ChannelInfo;
  onSaved: (changes: { name: string; applied_tags: ForumTag[] }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(channel.name);
  const [tags, setTags] = useState<ForumTag[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!channel.can_edit_post) return null;

  const start = async () => {
    setOpen(true);
    setTitle(channel.name);
    setPicked((channel.applied_tags ?? []).map((tag) => tag.id));
    setError("");
    if (channel.parent_kind === "forum" && channel.parent_id) {
      try {
        const parent = await fetchChannel(channel.parent_id);
        setTags(parent.tags ?? []);
      } catch {
        setTags([]);
      }
    } else {
      setTags([]);
    }
  };

  const save = async () => {
    const name = title.split(/\s+/).filter(Boolean).join(" ");
    if (!name) {
      setError(errors.bad_title ?? "");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const forum = channel.parent_kind === "forum";
      await editPost(channel.id, { title: name, tag_ids: forum ? picked : undefined });
      onSaved({ name, applied_tags: forum ? (tags ?? []).filter((tag) => picked.includes(tag.id)) : channel.applied_tags ?? [] });
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof ApiError ? (errors[caught.code] ?? "고치지 못했어요. 다시 해 주세요.") : "서버에 연결할 수 없어요.");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="text-button post-edit-open" onClick={() => void start()}>
        {channel.parent_kind === "forum" ? "제목, 태그 고치기" : "제목 고치기"}
      </button>
    );
  }
  return (
    <div className="post-edit" role="group" aria-label="글 제목과 태그 고치기">
      <label className="install-field">
        <span>제목</span>
        <input value={title} maxLength={100} onChange={(event) => setTitle(event.target.value)} />
      </label>
      {tags === null && <p className="post-edit-note">태그를 불러오는 중…</p>}
      {tags && tags.length > 0 && (
        <div className="post-edit-tags" role="group" aria-label="태그">
          {tags.map((tag) => {
            const on = picked.includes(tag.id);
            return (
              <button
                key={tag.id}
                type="button"
                className={on ? "tag-chip tag-chip-on" : "tag-chip"}
                aria-pressed={on}
                disabled={!tag.usable && !on}
                title={tag.usable ? undefined : "관리자 전용 태그"}
                onClick={() => setPicked(on ? picked.filter((id) => id !== tag.id) : [...picked, tag.id].slice(0, 5))}
              >
                {tag.emoji ? `${tag.emoji} ` : ""}
                {tag.name}
              </button>
            );
          })}
        </div>
      )}
      {error && <p className="composer-error">{error}</p>}
      <div className="post-edit-actions">
        <button type="button" className="pill-button" onClick={() => setOpen(false)} disabled={busy}>
          취소
        </button>
        <button type="button" className="pill-button pill-button-strong" onClick={() => void save()} disabled={busy}>
          저장
        </button>
      </div>
    </div>
  );
}

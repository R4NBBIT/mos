// 화면에서 바로 고치는 글(문서 제목, 파일 이름 등). 누르면 입력칸, Enter나 다른 곳을 누르면 저장, Esc는 취소
import { type KeyboardEvent, useState } from "react";

interface Props {
  value: string;
  /** 비우면 돌아갈 원래 값 */
  fallback: string;
  onSave: (text: string | null) => void;
  label: string;
  className?: string;
  as?: "h1" | "p" | "span";
  maxLength?: number;
}

export default function EditableText({ value, fallback, onSave, label, className, as: Tag = "span", maxLength = 80 }: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  const finish = (keep: boolean) => {
    if (draft === null) return;
    const text = draft.split(/\s+/).join(" ").trim();
    setDraft(null);
    if (!keep || text === value) return;
    onSave(text === "" || text === fallback ? null : text);
  };
  if (draft !== null) {
    return (
      <Tag className={className}>
        <input
          className="editable-input"
          aria-label={label}
          value={draft}
          maxLength={maxLength}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => finish(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              finish(true);
            } else if (event.key === "Escape") {
              finish(false);
            }
          }}
        />
      </Tag>
    );
  }
  const start = () => setDraft(value);
  return (
    <Tag
      className={className ? `${className} editable` : "editable"}
      role="button"
      tabIndex={0}
      aria-label={`${label}: ${value}, 눌러서 고치기`}
      onClick={start}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key === "Enter") {
          event.preventDefault();
          start();
        }
      }}
    >
      {value}
    </Tag>
  );
}

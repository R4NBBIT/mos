// 위장 화면: 노션 페이지, Word 문서. 예시 글이나 올린 파일의 글을 문단(블록)으로 보여 주고,
// 문단을 눌러 바로 고칠 수 있다(Enter로 새 문단, 빈 문단에서 지우기를 누르면 문단 삭제). 고친 내용은 계정에 저장.
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import WordChrome from "../WordChrome";
import { localEdits, pullEdits, pushEdits } from "./bossStore";

type BlockType = "h1" | "h2" | "h3" | "bullet" | "number" | "todo" | "done" | "quote" | "p";

interface Block {
  id: number;
  type: BlockType;
  text: string;
}

const MAX_TEXT = 190_000;
let nextId = 1;

const PREFIX: Record<BlockType, string> = {
  h1: "# ",
  h2: "## ",
  h3: "### ",
  bullet: "- ",
  number: "1. ",
  todo: "[ ] ",
  done: "[x] ",
  quote: "> ",
  p: "",
};

function parse(text: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    let type: BlockType = "p";
    let body = line;
    const match =
      /^(#{1,3}) (.*)$/.exec(line) ??
      /^([-*]) (.*)$/.exec(line) ??
      /^(\d+[.)]) (.*)$/.exec(line) ??
      /^(\[[ xX]?\]) (.*)$/.exec(line) ??
      /^(>) ?(.*)$/.exec(line);
    if (match) {
      const mark = match[1] ?? "";
      body = match[2] ?? "";
      if (mark.startsWith("#")) type = mark.length === 1 ? "h1" : mark.length === 2 ? "h2" : "h3";
      else if (mark === "-" || mark === "*") type = "bullet";
      else if (mark.startsWith("[")) type = /x/i.test(mark) ? "done" : "todo";
      else if (mark === ">") type = "quote";
      else type = "number";
    }
    blocks.push({ id: nextId++, type, text: body });
  }
  return blocks.length > 0 ? blocks : [{ id: nextId++, type: "p", text: "" }];
}

function serialize(blocks: Block[]): string {
  return blocks.map((block) => PREFIX[block.type] + block.text).join("\n");
}

/** 예시 글의 '11월 3주차' */
export function weekLabel(today = new Date()): string {
  return `${today.getMonth() + 1}월 ${Math.ceil(today.getDate() / 7)}주차`;
}

export function noteExample(): string {
  return [
    "# 업무 정리",
    `> ${weekLabel()} 진행 상황을 정리한 페이지예요.`,
    "## 이번 주 TODO",
    "[x] 신규 입사자 계정 발급",
    "[x] 회의실 예약 시스템 점검",
    "[ ] 분기 보고서 초안 작성",
    "[ ] 장비 교체 일정 확인",
    "## 회의 메모",
    "- 다음 주 화요일 오전 10시 팀 회의",
    "- 고객 문의 처리 기준을 다시 정리하기로 함",
    "## 참고",
    "1. 보고서 양식은 공용 드라이브 '양식' 폴더",
    "1. 비용 처리는 월말까지 제출",
  ].join("\n");
}

export function wordExample(): string {
  return [
    "# 주간 업무 보고",
    `운영지원팀, ${weekLabel()}`,
    "## 1. 이번 주 한 일",
    "- 고객 문의 처리 현황 정리(총 42건, 처리율 95%)",
    "- 신규 입사자 3명 계정 발급과 장비 지급",
    "- 회의실 예약 시스템 점검과 오류 수정 요청",
    "## 2. 다음 주 TODO",
    "- 분기 보고서 초안 작성",
    "- 장비 교체 일정 확인과 업체 견적 비교",
    "## 3. 건의 사항",
    "사무용품 신청 주기를 월 1회에서 격주로 바꾸면 좋겠습니다.",
  ].join("\n");
}

export function memoExample(): string {
  return [
    "업무 메모",
    "",
    `${weekLabel()} 확인할 것`,
    "- 주간 회의 자료 정리(화)",
    "- 거래처 견적서 회신",
    "- 비품 신청 목록 취합",
    "",
    "전화 메모",
    "- 김 과장님: 계약서 수정본 내일 오전까지",
    "- 총무팀: 회의실 예약 변경 확인 부탁",
    "",
    "기타",
    "- 분기 보고서 초안은 다음 주 수요일까지",
  ].join("\r\n");
}

/** 문서 제목(첫 줄이 '# '이면 그 글) */
export function docTitle(text: string, fallback: string): string {
  const first = text
    .replace(/\r/g, "")
    .split("\n")
    .find((line) => line.trim());
  const match = first ? /^# (.+)$/.exec(first.trim()) : null;
  return match?.[1]?.trim() || fallback;
}

/** 고친 내용을 불러오고 저장하는 공통 부분 */
function useDocBlocks(original: string, editKey: string): [Block[], (next: Block[]) => void] {
  const [blocks, setBlocks] = useState<Block[]>(() => parse(localEdits<string>(editKey) ?? original));
  useEffect(() => {
    let stopped = false;
    setBlocks(parse(localEdits<string>(editKey) ?? original));
    pullEdits<string>(editKey)
      .then((saved) => {
        if (!stopped && typeof saved === "string") setBlocks(parse(saved));
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [original, editKey]);
  const update = (next: Block[]) => {
    setBlocks(next);
    pushEdits(editKey, serialize(next).slice(0, MAX_TEXT));
  };
  return [blocks, update];
}

function DocBlocks({
  blocks,
  onChange,
  kind,
}: {
  blocks: Block[];
  onChange: (next: Block[]) => void;
  kind: "note" | "word";
}) {
  const focusId = useRef<{ id: number; atEnd: boolean } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = focusId.current;
    if (!target) return;
    focusId.current = null;
    const element = rootRef.current?.querySelector<HTMLElement>(`[data-block="${target.id}"]`);
    if (!element) return;
    element.focus();
    if (target.atEnd) {
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  });

  const commit = (id: number, text: string) => {
    const block = blocks.find((item) => item.id === id);
    if (block && block.text !== text) onChange(blocks.map((item) => (item.id === id ? { ...item, text } : item)));
  };

  const onKey = (event: KeyboardEvent<HTMLElement>, block: Block, index: number) => {
    if (event.nativeEvent.isComposing) return;
    const text = event.currentTarget.textContent ?? "";
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const continues = ["bullet", "number", "todo", "done"].includes(block.type) && text.trim() !== "";
      const added: Block = {
        id: nextId++,
        type: continues ? (block.type === "done" ? "todo" : block.type) : "p",
        text: "",
      };
      const next = blocks.map((item) => (item.id === block.id ? { ...item, text } : item));
      next.splice(index + 1, 0, added);
      focusId.current = { id: added.id, atEnd: false };
      onChange(next);
    } else if (event.key === "Backspace" && text === "" && blocks.length > 1) {
      event.preventDefault();
      if (block.type !== "p") {
        onChange(blocks.map((item) => (item.id === block.id ? { ...item, type: "p" } : item)));
        focusId.current = { id: block.id, atEnd: true };
        return;
      }
      const previous = blocks[index - 1] ?? blocks[index + 1];
      if (previous) focusId.current = { id: previous.id, atEnd: true };
      onChange(blocks.filter((item) => item.id !== block.id));
    }
  };

  let number = 0;
  return (
    <div ref={rootRef} className={`doc-blocks doc-${kind}`}>
      {blocks.map((block, index) => {
        number = block.type === "number" ? number + 1 : 0;
        const editable = (
          <div
            className="doc-text"
            data-block={block.id}
            contentEditable="plaintext-only"
            suppressContentEditableWarning
            spellCheck={false}
            role="textbox"
            aria-label="문단"
            data-placeholder={index === 0 ? "제목" : ""}
            onBlur={(event) => commit(block.id, event.currentTarget.textContent ?? "")}
            onKeyDown={(event) => onKey(event, block, index)}
          >
            {block.text}
          </div>
        );
        return (
          <div key={block.id} className={`doc-block doc-${block.type}`}>
            {block.type === "bullet" && (
              <span className="doc-mark" aria-hidden="true">
                •
              </span>
            )}
            {block.type === "number" && (
              <span className="doc-mark" aria-hidden="true">
                {number}.
              </span>
            )}
            {(block.type === "todo" || block.type === "done") && (
              <input
                type="checkbox"
                className="doc-check"
                aria-label="완료"
                checked={block.type === "done"}
                onChange={(event) =>
                  onChange(
                    blocks.map((item) =>
                      item.id === block.id
                        ? {
                            ...item,
                            type: event.target.checked ? "done" : "todo",
                          }
                        : item,
                    ),
                  )
                }
              />
            )}
            {editable}
          </div>
        );
      })}
    </div>
  );
}

const NOTE_PAGES = ["회의록", "TODO 목록", "자료 모음", "주간 일정"];

/** 노션 페이지처럼: 왼쪽 사이드바, 위 경로 줄, 큰 제목과 블록 */
export function NoteDisguise({
  original,
  editKey,
  fallbackTitle,
}: {
  original: string;
  editKey: string;
  fallbackTitle: string;
}) {
  const [blocks, update] = useDocBlocks(original, editKey);
  const title = blocks[0]?.type === "h1" && blocks[0].text ? blocks[0].text : fallbackTitle;
  return (
    <div className="boss-note">
      <aside className="bn-side" aria-hidden="true">
        <div className="bn-space">
          <span className="bn-space-icon">업</span>
          <strong>업무 공간</strong>
        </div>
        <div className="bn-nav">
          <span>🔍 검색</span>
          <span>🏠 홈</span>
          <span>📥 받은 편지함</span>
        </div>
        <div className="bn-section">개인 페이지</div>
        <span className="bn-page bn-page-on">📝 {title}</span>
        {NOTE_PAGES.map((page) => (
          <span key={page} className="bn-page">
            📄 {page}
          </span>
        ))}
      </aside>
      <main className="bn-main">
        <header className="bn-top" aria-hidden="true">
          <span className="bn-crumb">
            개인 페이지 <span>/</span> {title}
          </span>
          <span className="bn-top-right">
            <span>편집 1분 전</span>
            <span>공유</span>
            <span>☆</span>
            <span>⋯</span>
          </span>
        </header>
        <div className="bn-scroll">
          <div className="bn-pagebody">
            <div className="bn-icon" aria-hidden="true">
              📝
            </div>
            <DocBlocks blocks={blocks} onChange={update} kind="note" />
          </div>
        </div>
      </main>
    </div>
  );
}

/** Word 문서처럼: 파란 제목 줄과 리본, 회색 바탕 위 흰 종이 */
export function WordDisguise({ original, editKey, name }: { original: string; editKey: string; name: string }) {
  const [blocks, update] = useDocBlocks(original, editKey);
  const words = blocks.reduce((sum, block) => sum + (block.text.trim() ? block.text.trim().split(/\s+/).length : 0), 0);
  return (
    <div className="boss-word">
      <WordChrome name={name} />
      <div className="bw-canvas">
        <article className="bw-page">
          <DocBlocks blocks={blocks} onChange={update} kind="word" />
        </article>
      </div>
      <footer className="bw-status" aria-hidden="true">
        <span>1/1 페이지</span>
        <span>단어 {words}개</span>
        <span>한국어</span>
        <span className="bw-status-right">100%</span>
      </footer>
    </div>
  );
}

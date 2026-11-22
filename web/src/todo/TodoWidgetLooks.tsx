// 위젯 모양: ㅁㅇㅅ 테마마다 그 프로그램처럼(2026-11-22 사용자 요청 '모든 테마 위젯').
// 기본(moon)과 다크(night)는 카드 모양, sheet는 엑셀 표, memo는 메모장, note는 노션 페이지, word는 Word 문서.
// 이름은 어디에도 원래 서비스 이름 없이 'TODO'만 쓴다.
import { longLabel, timeLabel } from "./dates";
import { CHECK_PATH, checkStyle } from "./TodoItems";
import type { TodoItem } from "./todoApi";

export type WidgetLookName = "card" | "sheet" | "memo" | "note" | "word";

export interface WidgetModel {
  day: string;
  /** 안 한 것 먼저, 시각 순 */
  items: TodoItem[];
  done: number;
  colorOf: (item: TodoItem) => string | undefined;
  onToggle: (item: TodoItem) => void;
  /** 불러오기 실패나 빈 날 안내(없으면 null) */
  note: string | null;
}

export function widgetLook(theme: string | undefined): WidgetLookName {
  if (
    theme === "sheet" ||
    theme === "memo" ||
    theme === "note" ||
    theme === "word"
  )
    return theme;
  return "card"; // moon, night
}

function shortDay(day: string): string {
  return `${Number(day.slice(5, 7))}월 ${Number(day.slice(8, 10))}일`;
}

function Check({ model, item }: { model: WidgetModel; item: TodoItem }) {
  return (
    <button
      type="button"
      className={item.done ? "todo-check todo-check-on" : "todo-check"}
      style={checkStyle(model.colorOf(item))}
      aria-pressed={item.done}
      aria-label={`${item.title} ${item.done ? "완료 취소" : "완료"}`}
      onClick={() => model.onToggle(item)}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d={CHECK_PATH} />
      </svg>
    </button>
  );
}

/** 위젯 한 줄: 'TODO | 시각 | 장소', 같은 글꼴과 크기(2026-11-23 사용자 요청). 메모는 안 보임 */
function lineOf(item: TodoItem): string {
  return [item.title, item.time ? timeLabel(item.time) : "", item.place ?? ""]
    .filter(Boolean)
    .join(" | ");
}

// ------------------------------------------------------------ 기본, 다크: 카드
function CardLook({ model }: { model: WidgetModel }) {
  const total = model.items.length;
  const percent = total === 0 ? 0 : Math.round((model.done / total) * 100);
  return (
    <>
      <header className="todo-widget-head">
        <div className="todo-widget-heading">
          <span className="todo-widget-brand">TODO</span>
          <strong>{longLabel(model.day)}</strong>
        </div>
        <span
          className="todo-widget-count"
          aria-label={`${total}개 중 ${model.done}개 했어요`}
        >
          {model.done}
          <small>/{total}</small>
        </span>
      </header>
      <div className="todo-widget-bar" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </div>
      <ul className="todo-widget-list">
        {model.items.map((item) => (
          <li
            key={item.id}
            className={
              item.done
                ? "todo-widget-item todo-widget-done"
                : "todo-widget-item"
            }
          >
            <Check model={model} item={item} />
            <span className="todo-widget-title">{lineOf(item)}</span>
          </li>
        ))}
      </ul>
      {model.note && (
        <p className="todo-widget-note todo-widget-empty">{model.note}</p>
      )}
    </>
  );
}

// ------------------------------------------------------------ 스프레드시트: 엑셀 표
const SHEET_ROWS = 14;

function SheetLook({ model }: { model: WidgetModel }) {
  const total = model.items.length;
  const blanks = Math.max(0, SHEET_ROWS - total - 2);
  return (
    <>
      <div className="tw-sheet-title">
        <span className="tw-sheet-logo" aria-hidden="true">
          X
        </span>
        <span className="tw-grow">TODO.xlsx</span>
        <span className="tw-sheet-saved">저장됨</span>
      </div>
      <div className="tw-sheet-fx">
        <span className="tw-sheet-name">B1</span>
        <span className="tw-sheet-fx-mark">fx</span>
        <span className="tw-grow">
          {shortDay(model.day)} TODO {model.done}/{total}
        </span>
      </div>
      <div className="tw-sheet-grid" role="table" aria-label="오늘 TODO">
        <div className="tw-sheet-row tw-sheet-head" role="row">
          <span className="tw-sheet-num" />
          <span>A</span>
          <span>B</span>
          <span>C</span>
          <span>D</span>
        </div>
        <div className="tw-sheet-row tw-sheet-label" role="row">
          <span className="tw-sheet-num">1</span>
          <span>완료</span>
          <span>TODO</span>
          <span>시각</span>
          <span>장소</span>
        </div>
        {model.items.map((item, index) => (
          <div
            key={item.id}
            className={item.done ? "tw-sheet-row tw-done" : "tw-sheet-row"}
            role="row"
          >
            <span className="tw-sheet-num">{index + 2}</span>
            <span className="tw-sheet-check">
              <Check model={model} item={item} />
            </span>
            <span className="tw-sheet-text">{item.title}</span>
            <span className="tw-sheet-time">{item.time ?? ""}</span>
            <span className="tw-sheet-text">{item.place ?? ""}</span>
          </div>
        ))}
        {Array.from({ length: blanks }, (_, index) => (
          <div
            key={`blank-${index}`}
            className="tw-sheet-row"
            aria-hidden="true"
          >
            <span className="tw-sheet-num">{total + 3 + index}</span>
            <span />
            <span />
            <span />
            <span />
          </div>
        ))}
      </div>
      {model.note && <p className="tw-sheet-note">{model.note}</p>}
      <div className="tw-sheet-tabs">
        <span className="tw-sheet-tab-on">{shortDay(model.day)}</span>
        <span className="tw-grow" />
        <span>
          {model.done}/{total}
        </span>
      </div>
    </>
  );
}

// ------------------------------------------------------------ 메모장: 글자 한 장
function MemoLook({ model }: { model: WidgetModel }) {
  const total = model.items.length;
  return (
    <>
      <div className="tw-memo-title">TODO.txt - 메모장</div>
      <div className="tw-memo-menu" aria-hidden="true">
        <span>파일</span>
        <span>편집</span>
        <span>서식</span>
        <span>보기</span>
        <span>도움말</span>
      </div>
      <div className="tw-memo-text">
        <div className="tw-memo-line tw-memo-head">
          == {shortDay(model.day)} == ({model.done}/{total})
        </div>
        {model.items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={item.done ? "tw-memo-line tw-done" : "tw-memo-line"}
            aria-pressed={item.done}
            aria-label={`${item.title} ${item.done ? "완료 취소" : "완료"}`}
            onClick={() => model.onToggle(item)}
          >
            <span className="tw-memo-mark">{item.done ? "[✓]" : "[ ]"}</span>
            <span className="tw-memo-text"> {lineOf(item)}</span>
          </button>
        ))}
        {model.note && (
          <div className="tw-memo-line tw-memo-dim">{model.note}</div>
        )}
      </div>
      <div className="tw-memo-status">
        <span className="tw-grow">줄 {total + 1}, 열 1</span>
        <span>100%</span>
        <span>UTF-8</span>
      </div>
    </>
  );
}

// ------------------------------------------------------------ 노션: 페이지
function NoteLook({ model }: { model: WidgetModel }) {
  const total = model.items.length;
  return (
    <>
      <div className="tw-note-crumb">
        <span className="tw-note-icon" aria-hidden="true">
          ✓
        </span>
        TODO
      </div>
      <div className="tw-note-page">
        <h1 className="tw-note-h1">TODO</h1>
        <div className="tw-note-props">
          <span className="tw-note-prop-name">날짜</span>
          <span>{longLabel(model.day)}</span>
          <span className="tw-note-prop-name">진행</span>
          <span>
            {model.done}/{total}
          </span>
        </div>
        <ul className="tw-note-list">
          {model.items.map((item) => (
            <li
              key={item.id}
              className={item.done ? "tw-note-todo tw-done" : "tw-note-todo"}
            >
              <Check model={model} item={item} />
              <span className="tw-note-text">{lineOf(item)}</span>
            </li>
          ))}
        </ul>
        {model.note && <p className="tw-note-dim">{model.note}</p>}
      </div>
    </>
  );
}

// ------------------------------------------------------------ Word: 문서
function WordLook({ model }: { model: WidgetModel }) {
  const total = model.items.length;
  return (
    <>
      <div className="tw-word-title">
        <span className="tw-word-logo" aria-hidden="true">
          W
        </span>
        <span className="tw-grow">TODO.docx</span>
      </div>
      <div className="tw-word-tabs" aria-hidden="true">
        <span>파일</span>
        <span className="tw-word-tab-on">홈</span>
        <span>삽입</span>
        <span>레이아웃</span>
        <span>검토</span>
      </div>
      <div className="tw-word-canvas">
        <div className="tw-word-page">
          <h2 className="tw-word-heading">{longLabel(model.day)}</h2>
          <ul className="tw-word-list">
            {model.items.map((item) => (
              <li
                key={item.id}
                className={item.done ? "tw-word-item tw-done" : "tw-word-item"}
              >
                <Check model={model} item={item} />
                <span className="tw-word-text">{lineOf(item)}</span>
              </li>
            ))}
          </ul>
          {model.note && <p className="tw-word-dim">{model.note}</p>}
        </div>
      </div>
      <div className="tw-word-status">
        <span className="tw-grow">1/1 페이지</span>
        <span>
          {model.done}/{total} 완료
        </span>
        <span>한국어</span>
      </div>
    </>
  );
}

export function WidgetLook({
  look,
  model,
}: {
  look: WidgetLookName;
  model: WidgetModel;
}) {
  if (look === "sheet") return <SheetLook model={model} />;
  if (look === "memo") return <MemoLook model={model} />;
  if (look === "note") return <NoteLook model={model} />;
  if (look === "word") return <WordLook model={model} />;
  return <CardLook model={model} />;
}

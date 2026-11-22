import { useBossTodo } from "./bossTodo";
import { type KeyboardEvent, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { address, colName, display, type Evaluated, makeCalculator, parseAddress } from "./formula";
import { localEdits, pullEdits, pushEdits } from "./bossStore";
import type { CellStyle, SheetData, Workbook } from "./templates";

// 위장 화면(SCR-12): 진짜처럼 동작하는 표. 셀 선택·방향키·입력·수식 재계산·시트 탭.
// 고친 값은 계정에 저장한다(다른 브라우저·PC에서도 그대로).

const ROW_H = 24;
const HEAD_H = 22;
const ROWNUM_W = 40;
const DEFAULT_W = 80;
const MAX_RAW = 1000;
const MAX_STORED = 200_000;

type Edits = Record<string, Record<string, string>>;

function loadEdits(key: string): Edits {
  const value = localEdits<unknown>(key);
  return value && typeof value === "object" ? (value as Edits) : {};
}

/** 고친 값은 계정에 저장(다른 브라우저에서도 그대로). 이 브라우저에도 사본 */
function saveEdits(key: string, edits: Edits): void {
  if (JSON.stringify(edits).length <= MAX_STORED) pushEdits(key, edits);
}

interface Pos {
  col: number;
  row: number;
}

function sizeOf(sheet: SheetData, edits: Record<string, string>): { cols: number; rows: number } {
  let cols = sheet.widths.length;
  let rows = 0;
  for (const key of [...Object.keys(sheet.cells), ...Object.keys(edits)]) {
    const pos = parseAddress(key);
    if (!pos) continue;
    cols = Math.max(cols, pos.col + 1);
    rows = Math.max(rows, pos.row);
  }
  return {
    cols: Math.min(Math.max(cols + 2, 10), 40),
    rows: Math.min(Math.max(rows + 20, 40), 600),
  };
}

function cellClass(style: CellStyle | undefined, result: Evaluated, overflow: boolean): string {
  const classes = ["boss-cell"];
  const right = style?.right ?? (typeof result.value === "number" || Boolean(result.error));
  if (right) classes.push("boss-right");
  if (style?.b) classes.push("boss-b");
  if (style?.top) classes.push("boss-top");
  if (result.error) classes.push("boss-error");
  if (overflow && !right) classes.push("boss-overflow");
  return classes.join(" ");
}

interface GridProps {
  sheet: SheetData;
  edits: Record<string, string>;
  cols: number;
  rows: number;
  widths: number[];
  onPick: (pos: Pos, edit: boolean) => void;
}

/** 셀 격자. 선택·입력은 위에 겹친 칸이 맡아서, 글자를 칠 때마다 격자 전체를 다시 그리지 않는다 */
const Grid = memo(function Grid({ sheet, edits, cols, rows, widths, onPick }: GridProps) {
  const rawOf = (key: string) => (key in edits ? (edits[key] ?? "") : (sheet.cells[key] ?? ""));
  const calc = makeCalculator(rawOf);
  const template = `${ROWNUM_W}px ${widths.map((width) => `${width}px`).join(" ")}`;
  const lines = [];
  for (let row = 1; row <= rows; row += 1) {
    const cells = [];
    for (let col = 0; col < cols; col += 1) {
      const key = address(col, row);
      const raw = rawOf(key);
      if (!raw) {
        cells.push(
          <div
            key={key}
            className="boss-cell"
            style={sheet.styles[key]?.bg ? { background: sheet.styles[key]?.bg } : undefined}
          />,
        );
        continue;
      }
      const style = sheet.styles[key];
      const result = calc(key);
      const nextEmpty = col + 1 < cols && !rawOf(address(col + 1, row));
      cells.push(
        <div
          key={key}
          className={cellClass(style, result, nextEmpty)}
          style={{
            background: style?.bg,
            color: style?.fg,
            fontSize: style?.size,
          }}
        >
          {nextEmpty && !style?.right && typeof result.value === "string" ? (
            // 옆 빈 칸으로 넘치는 글자는 엑셀처럼 그 아래 격자선을 가린다
            <span className="boss-spill" style={{ background: style?.bg ?? "#ffffff" }}>
              {display(result, style?.fmt)}
            </span>
          ) : (
            display(result, style?.fmt)
          )}
        </div>,
      );
    }
    lines.push(
      <div key={row} className="boss-row" style={{ gridTemplateColumns: template }}>
        <div className="boss-rownum">{row}</div>
        {cells}
      </div>,
    );
  }
  return (
    <div
      className="boss-rows"
      onMouseDown={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        const x = event.clientX - box.left - ROWNUM_W;
        const y = event.clientY - box.top;
        if (x < 0) return;
        let col = 0;
        let edge = widths[0] ?? DEFAULT_W;
        while (x > edge && col < cols - 1) {
          col += 1;
          edge += widths[col] ?? DEFAULT_W;
        }
        onPick({ col, row: Math.min(rows, Math.floor(y / ROW_H) + 1) }, event.detail >= 2);
        event.preventDefault();
      }}
    >
      {lines}
    </div>
  );
});

const MENUS = ["파일", "홈", "삽입", "페이지 레이아웃", "수식", "데이터", "검토", "보기"];

interface Props {
  workbook: Workbook;
  /** 고친 값을 기억할 이 브라우저 저장소 열쇠(템플릿·파일마다) */
  storageKey: string;
  active: boolean;
}

export default function BossScreen({ workbook, storageKey, active }: Props) {
  const goTodo = useBossTodo();
  const [sheetIndex, setSheetIndex] = useState(0);
  const [edits, setEdits] = useState<Edits>(() => loadEdits(storageKey));
  const [draft, setDraft] = useState<string | null>(null);
  const [typedStart, setTypedStart] = useState(false); // 바로 쳐서 시작한 입력이면 방향키로 확정하고 이동
  const sheet = workbook.sheets[sheetIndex] ??
    workbook.sheets[0] ?? { name: "Sheet1", widths: [], cells: {}, styles: {} };
  const cursorOf = useCallback((target: SheetData): Pos => {
    const pos = target.cursor ? parseAddress(target.cursor) : null;
    return pos ?? { col: 0, row: 1 };
  }, []);
  const [sel, setSel] = useState<Pos>(() => cursorOf(sheet));
  const editorRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 다른 템플릿·파일로 바뀌면 처음 상태로. 계정에 저장된 고친 값이 있으면 그걸로
  useEffect(() => {
    let stopped = false;
    setEdits(loadEdits(storageKey));
    setSheetIndex(0);
    setDraft(null);
    setSel(cursorOf(workbook.sheets[0] ?? { name: "", widths: [], cells: {}, styles: {} }));
    pullEdits<Edits>(storageKey)
      .then((saved) => {
        if (stopped) return;
        if (saved && typeof saved === "object") setEdits(saved);
        else {
          const local = loadEdits(storageKey);
          if (Object.keys(local).length > 0) pushEdits(storageKey, local); // 예전에 이 브라우저에만 있던 것
        }
      })
      .catch(() => {}); // 잠겨 있으면 이 브라우저 사본으로
    return () => {
      stopped = true;
    };
  }, [storageKey, workbook, cursorOf]);

  const sheetEdits = useMemo(() => edits[String(sheetIndex)] ?? {}, [edits, sheetIndex]);
  const { cols, rows } = sizeOf(sheet, sheetEdits);
  const widths = useMemo(
    () => Array.from({ length: cols }, (_, index) => sheet.widths[index] ?? DEFAULT_W),
    [cols, sheet.widths],
  );
  const rawOf = (key: string) => (key in sheetEdits ? (sheetEdits[key] ?? "") : (sheet.cells[key] ?? ""));
  const selKey = address(sel.col, sel.row);
  const calc = useMemo(
    () => makeCalculator((key) => (key in sheetEdits ? (sheetEdits[key] ?? "") : (sheet.cells[key] ?? ""))),
    [sheet, sheetEdits],
  );
  const selected = calc(selKey);

  const focusEditor = useCallback(() => {
    editorRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (active) focusEditor();
  }, [active, focusEditor, sheetIndex]);

  // 선택한 셀이 보이게 스크롤
  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const left = widths.slice(0, sel.col).reduce((a, b) => a + b, 0);
    const right = left + (widths[sel.col] ?? DEFAULT_W);
    const top = (sel.row - 1) * ROW_H;
    const bottom = top + ROW_H;
    const viewW = box.clientWidth - ROWNUM_W;
    const viewH = box.clientHeight - HEAD_H;
    if (left < box.scrollLeft) box.scrollLeft = left;
    else if (right > box.scrollLeft + viewW) box.scrollLeft = right - viewW;
    if (top < box.scrollTop) box.scrollTop = top;
    else if (bottom > box.scrollTop + viewH) box.scrollTop = bottom - viewH;
  }, [sel, widths]);

  const commit = (value: string) => {
    const next: Edits = {
      ...edits,
      [String(sheetIndex)]: {
        ...sheetEdits,
        [selKey]: value.slice(0, MAX_RAW),
      },
    };
    setEdits(next);
    saveEdits(storageKey, next);
    setDraft(null);
  };

  const move = (dCol: number, dRow: number) => {
    setSel((current) => ({
      col: Math.min(cols - 1, Math.max(0, current.col + dCol)),
      row: Math.min(rows, Math.max(1, current.row + dRow)),
    }));
  };

  // 격자는 다시 그리지 않도록 고정된 함수를 넘기고, 최신 상태는 ref로 읽는다
  const latest = useRef({
    draft,
    sel,
    edits,
    sheetEdits,
    sheetIndex,
    sheet,
    storageKey,
  });
  latest.current = {
    draft,
    sel,
    edits,
    sheetEdits,
    sheetIndex,
    sheet,
    storageKey,
  };
  const pick = useCallback(
    (pos: Pos, edit: boolean) => {
      const now = latest.current;
      let base = now.sheetEdits;
      if (now.draft !== null) {
        // 다른 셀을 누르면 입력 확정(엑셀처럼)
        base = {
          ...now.sheetEdits,
          [address(now.sel.col, now.sel.row)]: now.draft.slice(0, MAX_RAW),
        };
        const next: Edits = { ...now.edits, [String(now.sheetIndex)]: base };
        setEdits(next);
        saveEdits(now.storageKey, next);
      }
      setSel(pos);
      const key = address(pos.col, pos.row);
      setDraft(edit ? (key in base ? (base[key] ?? "") : (now.sheet.cells[key] ?? "")) : null);
      setTypedStart(false);
      window.setTimeout(focusEditor, 0);
    },
    [focusEditor],
  );

  const onEditorKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const key = event.key;
    if (draft !== null) {
      if (key === "Enter") {
        event.preventDefault();
        commit(draft);
        move(0, event.shiftKey ? -1 : 1);
      } else if (key === "Tab") {
        event.preventDefault();
        commit(draft);
        move(event.shiftKey ? -1 : 1, 0);
      } else if (key === "Escape") {
        setDraft(null); // 취소(두 번 누르면 보스키로 돌아감)
      } else if (typedStart && key.startsWith("Arrow")) {
        event.preventDefault();
        commit(draft);
        move(
          key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0,
          key === "ArrowUp" ? -1 : key === "ArrowDown" ? 1 : 0,
        );
      }
      return;
    }
    const jumps: Record<string, [number, number]> = {
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      Enter: [0, 1],
      PageDown: [0, 20],
      PageUp: [0, -20],
    };
    const jump = jumps[key];
    if (jump) {
      event.preventDefault();
      const ctrl = event.ctrlKey || event.metaKey;
      if (ctrl && key === "ArrowDown") setSel((current) => ({ ...current, row: rows }));
      else if (ctrl && key === "ArrowUp") setSel((current) => ({ ...current, row: 1 }));
      else if (ctrl && key === "ArrowLeft") setSel((current) => ({ ...current, col: 0 }));
      else if (ctrl && key === "ArrowRight") setSel((current) => ({ ...current, col: cols - 1 }));
      else move(event.shiftKey && key === "Enter" ? 0 : jump[0], event.shiftKey && key === "Enter" ? -1 : jump[1]);
    } else if (key === "Tab") {
      event.preventDefault();
      move(event.shiftKey ? -1 : 1, 0);
    } else if (key === "Home") {
      event.preventDefault();
      setSel((current) => (event.ctrlKey || event.metaKey ? { col: 0, row: 1 } : { ...current, col: 0 }));
    } else if (key === "F2") {
      event.preventDefault();
      setDraft(rawOf(selKey));
      setTypedStart(false);
    } else if (key === "Delete" || key === "Backspace") {
      event.preventDefault();
      if (rawOf(selKey)) commit("");
    }
  };

  const left = widths.slice(0, sel.col).reduce((a, b) => a + b, 0) + ROWNUM_W;
  const top = (sel.row - 1) * ROW_H + HEAD_H;
  const numeric = typeof selected.value === "number" && !selected.error;
  const template = `${ROWNUM_W}px ${widths.map((width) => `${width}px`).join(" ")}`;

  return (
    <div className="boss">
      <header className="boss-titlebar">
        <span>{workbook.fileName}</span>
      </header>
      <div className="boss-menus" aria-hidden="true">
        {MENUS.map((name) => (
          <span key={name} className={name === "홈" ? "boss-menu-on" : undefined}>
            {name}
          </span>
        ))}
      </div>
      <div className="boss-ribbon" aria-hidden="true">
        <span className="boss-box boss-font">맑은 고딕</span>
        <span className="boss-box">11</span>
        <b>가</b>
        <i>가</i>
        <u>가</u>
        <span className="boss-sep" />
        <span>병합하고 가운데 맞춤</span>
        <span>백분율</span>
        <span>조건부 서식</span>
        <span>정렬 및 필터</span>
      </div>
      <div className="boss-formula">
        <span className="boss-namebox">{selKey}</span>
        <span className="boss-fx" aria-hidden="true">
          fx
        </span>
        <input
          className="boss-formula-input"
          value={draft ?? rawOf(selKey)}
          maxLength={MAX_RAW}
          aria-label="수식 입력줄"
          onChange={(event) => {
            setDraft(event.target.value);
            setTypedStart(false);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter" && draft !== null) {
              event.preventDefault();
              commit(draft);
              focusEditor();
            } else if (event.key === "Escape") {
              setDraft(null);
              focusEditor();
            }
          }}
        />
      </div>
      <div className="boss-scroll" ref={scrollRef}>
        <div className="boss-colhead" style={{ gridTemplateColumns: template }}>
          <div className="boss-corner" />
          {widths.map((_, index) => (
            <div key={index} className={index === sel.col ? "boss-colname boss-on" : "boss-colname"}>
              {colName(index)}
            </div>
          ))}
        </div>
        <Grid sheet={sheet} edits={sheetEdits} cols={cols} rows={rows} widths={widths} onPick={pick} />
        <div
          className={draft !== null ? "boss-selection boss-editing" : "boss-selection"}
          style={{
            left,
            top,
            width: widths[sel.col] ?? DEFAULT_W,
            height: ROW_H,
          }}
        >
          <input
            ref={editorRef}
            className="boss-editor"
            value={draft ?? ""}
            maxLength={MAX_RAW}
            aria-label={`${selKey} 셀`}
            onChange={(event) => {
              if (draft === null) setTypedStart(true);
              setDraft(event.target.value);
            }}
            onKeyDown={onEditorKey}
          />
        </div>
      </div>
      <nav className="boss-tabs">
        <span className="boss-tabs-pad" />
        {workbook.sheets.map((item, index) => (
          <button
            key={`${item.name}-${index}`}
            type="button"
            tabIndex={-1}
            className={index === sheetIndex ? "boss-tab boss-tab-on" : "boss-tab"}
            onClick={() => {
              setDraft(null);
              setSheetIndex(index);
              setSel(cursorOf(item));
            }}
          >
            {item.name}
          </button>
        ))}
        {goTodo && (
          <button type="button" tabIndex={-1} className="boss-tab" onClick={goTodo}>
            TODO
          </button>
        )}
        <span className="boss-tab" aria-hidden="true">
          +
        </span>
      </nav>
      <footer className="boss-status">
        <span>{draft !== null ? "입력" : "준비"}</span>
        <span>
          {numeric ? `평균: ${display(selected)}  개수: 1  합계: ${display(selected)}    ` : ""}
          100%
        </span>
      </footer>
    </div>
  );
}

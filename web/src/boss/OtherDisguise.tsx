// 표가 아닌 위장 화면: 내 스크린샷 사진, 메모장 같은 글 문서(노션, Word는 DocDisguise.tsx).
import { useEffect, useRef, useState } from "react";
import { localEdits, pullEdits, pushEdits } from "./bossStore";

const TEXT_KEY = "mos.boss.text.v1";
const MAX_TEXT = 100_000;

/** 사진 가장자리 색의 평균(맞추기일 때 남는 곳을 이 색으로 채워 어색하지 않게) */
function edgeColor(image: HTMLImageElement): string {
  try {
    const size = 24;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return "#ffffff";
    context.drawImage(image, 0, 0, size, size);
    const { data } = context.getImageData(0, 0, size, size);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (x !== 0 && y !== 0 && x !== size - 1 && y !== size - 1) continue;
        const i = (y * size + x) * 4;
        r += data[i] ?? 0;
        g += data[i + 1] ?? 0;
        b += data[i + 2] ?? 0;
        n += 1;
      }
    }
    return `rgb(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)})`;
  } catch {
    return "#ffffff";
  }
}

export function ImageDisguise({ url, fit }: { url: string | null; fit: "cover" | "contain" }) {
  const [background, setBackground] = useState("#ffffff");
  if (!url) {
    return <div className="boss-image boss-image-empty">설정 › 위장 화면에서 사진을 올려 주세요.</div>;
  }
  return (
    <div className="boss-image" style={{ background }}>
      <img
        src={url}
        alt=""
        draggable={false}
        style={{ objectFit: fit }}
        onLoad={(event) => setBackground(edgeColor(event.currentTarget))}
      />
    </div>
  );
}

/** 메모장처럼 보이는 글 문서. 쓴 내용은 계정에 저장(처음 내용은 예시 글, 올린 .txt 또는 빈 문서) */
export function TextDisguise({
  original,
  active,
  editKey = TEXT_KEY,
}: {
  original: string;
  active: boolean;
  editKey?: string;
}) {
  const [text, setText] = useState(() => localEdits<string>(editKey) ?? original);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let stopped = false;
    setText(localEdits<string>(editKey) ?? original);
    pullEdits<string>(editKey)
      .then((saved) => {
        if (!stopped && typeof saved === "string") setText(saved);
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [original, editKey]);

  useEffect(() => {
    if (active) areaRef.current?.focus({ preventScroll: true });
  }, [active]);

  return (
    <div className="boss-text">
      <div className="boss-text-menu" aria-hidden="true">
        {["파일", "편집", "서식", "보기", "도움말"].map((name) => (
          <span key={name}>{name}</span>
        ))}
      </div>
      <textarea
        ref={areaRef}
        className="boss-text-area"
        value={text}
        spellCheck={false}
        aria-label="문서 내용"
        onChange={(event) => {
          const next = event.target.value.slice(0, MAX_TEXT);
          setText(next);
          pushEdits(editKey, next);
        }}
      />
      <div className="boss-text-status" aria-hidden="true">
        <span>줄 {text.split("\n").length}</span>
        <span>100%</span>
        <span>Windows (CRLF)</span>
        <span>UTF-8</span>
      </div>
    </div>
  );
}

export const TEXT_EDIT_KEY = TEXT_KEY;

/** 예시와 내 파일마다 고친 내용을 따로 기억하는 열쇠 */
export const EDIT_KEYS = {
  memo: "mos.boss.memo.v1",
  text: TEXT_KEY,
  note: "mos.boss.note.v1",
  notefile: "mos.boss.notefile.v1",
  word: "mos.boss.word.v1",
  wordfile: "mos.boss.wordfile.v1",
} as const;

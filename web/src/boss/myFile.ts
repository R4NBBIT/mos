// '내 파일 불러오기'(SCR-12 6번): .xlsx/.csv를 브라우저 안에서만 읽어 위장 화면으로 쓴다. 서버로 보내지 않는다.
// 라이브러리 없이 브라우저 내장 기능만 쓴다: 압축 해제는 DecompressionStream, XML은 DOMParser.
// 수식은 가져오지 않고 파일에 저장된 마지막 계산값을 쓴다(편집하면 그 셀부터는 이 앱의 수식으로 계산).

import type { CellStyle, SheetData, Workbook } from "./templates";

const STORE_KEY = "mos.boss.file.v1";
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ENTRY_BYTES = 30 * 1024 * 1024; // 압축을 푼 XML 한 개 한도(압축 폭탄 방지)
const MAX_SHEETS = 6;
const MAX_ROWS = 500;
const MAX_COLS = 40;
const MAX_RAW = 1000;
const MAX_STORED_CHARS = 2_000_000;

export class FileImportError extends Error {}

export interface StoredFile extends Workbook {
  /** 고친 값을 따로 기억하려고 파일마다 다른 표시 */
  stamp: string;
}

export function loadMyFile(): StoredFile | null {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as StoredFile;
    if (typeof value.fileName === "string" && Array.isArray(value.sheets) && value.sheets.length > 0) return value;
  } catch {
    // 못 읽으면 없는 것으로
  }
  return null;
}

export function clearMyFile(): void {
  try {
    window.localStorage.removeItem(STORE_KEY);
  } catch {
    // 무시
  }
}

function saveMyFile(file: StoredFile): void {
  const text = JSON.stringify(file);
  if (text.length > MAX_STORED_CHARS) throw new FileImportError("표 내용이 너무 많아요. 더 작은 파일을 골라 주세요.");
  try {
    window.localStorage.setItem(STORE_KEY, text);
  } catch {
    throw new FileImportError("이 브라우저에 저장할 공간이 없어요.");
  }
}

function cleanName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "통합 문서1.xlsx";
  return base.replace(/[\u0000-\u001f]/g, "").slice(0, 80) || "통합 문서1.xlsx";
}

/** 글자로 보여 줄 값. '='로 시작하면 수식으로 계산되지 않게 앞에 '를 붙인다 */
function asText(value: string): string {
  const text = value.slice(0, MAX_RAW);
  return text.startsWith("=") ? `'${text}` : text;
}

function colIndex(letters: string): number {
  let col = 0;
  for (const char of letters) col = col * 26 + (char.charCodeAt(0) - 64);
  return col - 1;
}

function colLetters(index: number): string {
  let name = "";
  let n = index + 1;
  while (n > 0) {
    const rest = (n - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

// ------------------------------------------------------------------ zip

interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  localOffset: number;
}

function readEntries(data: Uint8Array, notZip = "엑셀 파일(.xlsx)이 아니에요."): ZipEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65_557); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new FileImportError(notZip);
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count && i < 5000; i += 1) {
    if (offset + 46 > data.length || view.getUint32(offset, true) !== 0x02014b50) break;
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    entries.push({
      flags: view.getUint16(offset + 8, true),
      method: view.getUint16(offset + 10, true),
      compressedSize: view.getUint32(offset + 20, true),
      localOffset: view.getUint32(offset + 42, true),
      name: decoder.decode(data.subarray(offset + 46, offset + 46 + nameLength)),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_ENTRY_BYTES) {
      await reader.cancel();
      throw new FileImportError("파일 안의 내용이 너무 커요.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

async function readEntry(data: Uint8Array, entry: ZipEntry): Promise<string> {
  if (entry.flags & 1) throw new FileImportError("암호가 걸린 파일은 열 수 없어요.");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const at = entry.localOffset;
  if (at + 30 > data.length || view.getUint32(at, true) !== 0x04034b50) throw new FileImportError("파일이 손상됐어요.");
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  const body = data.subarray(start, start + entry.compressedSize);
  let bytes: Uint8Array;
  if (entry.method === 0) bytes = body;
  else if (entry.method === 8) bytes = await inflate(body);
  else throw new FileImportError("이 압축 방식은 읽을 수 없어요.");
  if (bytes.length > MAX_ENTRY_BYTES) throw new FileImportError("파일 안의 내용이 너무 커요.");
  return new TextDecoder().decode(bytes);
}

// ------------------------------------------------------------------ xlsx

function xml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) throw new FileImportError("파일 내용을 읽지 못했어요.");
  return doc;
}

function all(node: Document | Element, name: string): Element[] {
  return Array.from(node.getElementsByTagNameNS("*", name));
}

function first(node: Element, name: string): Element | undefined {
  return all(node, name)[0];
}

/** 날짜 일련번호(1900 기준) → 2026-11-21 */
function serialToDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000);
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return String(serial);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

type NumberKind = "date" | "pct" | "num";

function formatKinds(styles: Document | null): NumberKind[] {
  if (!styles) return [];
  const custom = new Map<number, string>();
  for (const fmt of all(styles, "numFmt")) {
    custom.set(Number(fmt.getAttribute("numFmtId")), fmt.getAttribute("formatCode") ?? "");
  }
  const xfsRoot = all(styles, "cellXfs")[0];
  if (!xfsRoot) return [];
  return Array.from(xfsRoot.children)
    .filter((child) => child.localName === "xf")
    .map((xf) => {
      const id = Number(xf.getAttribute("numFmtId") ?? 0);
      if (id === 9 || id === 10) return "pct";
      if ((id >= 14 && id <= 17) || id === 22 || (id >= 27 && id <= 36) || (id >= 50 && id <= 58)) return "date";
      const code = (custom.get(id) ?? "").replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");
      if (code.includes("%")) return "pct";
      if (/[yd]/i.test(code) || (/m/i.test(code) && !/[hs]/i.test(code))) return "date";
      return "num";
    });
}

function textOf(element: Element): string {
  // 일본어 읽는 법(rPh) 안의 글자는 빼고 모은다
  return all(element, "t")
    .filter((t) => t.parentElement?.localName !== "rPh")
    .map((t) => t.textContent ?? "")
    .join("");
}

async function parseXlsx(data: Uint8Array, fileName: string): Promise<Workbook> {
  const entries = readEntries(data);
  const byName = new Map(entries.map((entry) => [entry.name.replace(/^\//, ""), entry]));
  const read = async (name: string) => {
    const entry = byName.get(name);
    return entry ? readEntry(data, entry) : null;
  };
  const workbookXml = await read("xl/workbook.xml");
  const relsXml = await read("xl/_rels/workbook.xml.rels");
  if (!workbookXml || !relsXml) throw new FileImportError("엑셀 파일(.xlsx)이 아니에요.");
  const shared = await read("xl/sharedStrings.xml");
  const stylesText = await read("xl/styles.xml");
  const strings = shared ? all(xml(shared), "si").map(textOf) : [];
  const kinds = formatKinds(stylesText ? xml(stylesText) : null);

  const targets = new Map<string, string>();
  for (const rel of all(xml(relsXml), "Relationship")) {
    const target = rel.getAttribute("Target") ?? "";
    targets.set(rel.getAttribute("Id") ?? "", target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }

  const sheets: SheetData[] = [];
  for (const sheetNode of all(xml(workbookXml), "sheet")) {
    if (sheets.length >= MAX_SHEETS) break;
    if (sheetNode.getAttribute("state") === "hidden" || sheetNode.getAttribute("state") === "veryHidden") continue;
    const relId =
      sheetNode.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ??
      sheetNode.getAttribute("r:id") ??
      "";
    const path = targets.get(relId);
    const text = path ? await read(path) : null;
    if (!text) continue;
    const doc = xml(text);
    const cells: Record<string, string> = {};
    const styles: Record<string, CellStyle> = {};
    for (const cell of all(doc, "c")) {
      const ref = /^([A-Z]{1,3})(\d+)$/.exec(cell.getAttribute("r") ?? "");
      if (!ref) continue;
      const col = colIndex(ref[1] ?? "");
      const row = Number(ref[2]);
      if (col >= MAX_COLS || row > MAX_ROWS) continue;
      const type = cell.getAttribute("t") ?? "n";
      const v = first(cell, "v")?.textContent ?? "";
      let raw = "";
      if (type === "s") raw = asText(strings[Number(v)] ?? "");
      else if (type === "inlineStr") raw = asText(textOf(cell));
      else if (type === "str" || type === "e") raw = asText(v);
      else if (type === "b") raw = v === "1" ? "TRUE" : "FALSE";
      else if (v !== "") {
        const number = Number(v);
        const kind = kinds[Number(cell.getAttribute("s") ?? 0)] ?? "num";
        if (!Number.isFinite(number)) raw = asText(v);
        else if (kind === "date") raw = serialToDate(number);
        else if (kind === "pct") raw = `${Math.round(number * 1_000_000) / 10_000}%`;
        else raw = String(number);
      }
      if (raw === "") continue;
      const key = `${colLetters(col)}${row}`;
      cells[key] = raw;
      if (kinds[Number(cell.getAttribute("s") ?? 0)] === "pct") styles[key] = { fmt: "pct" };
    }
    const widths: number[] = [];
    for (const colNode of all(doc, "col")) {
      const min = Number(colNode.getAttribute("min"));
      const max = Math.min(Number(colNode.getAttribute("max")), MAX_COLS);
      const width = Number(colNode.getAttribute("width"));
      if (!Number.isFinite(min) || !Number.isFinite(width)) continue;
      for (let index = min; index <= max; index += 1) {
        widths[index - 1] = Math.min(400, Math.max(30, Math.round(width * 7 + 5)));
      }
    }
    sheets.push({
      name: (sheetNode.getAttribute("name") ?? `Sheet${sheets.length + 1}`).slice(0, 31),
      widths: Array.from({ length: widths.length }, (_, index) => widths[index] ?? 80),
      cells,
      styles,
    });
  }
  if (sheets.length === 0) throw new FileImportError("보이는 시트가 없어요.");
  return { fileName, sheets };
}

// ------------------------------------------------------------------ csv

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("euc-kr").decode(bytes); // 엑셀이 저장한 한글 CSV
  }
}

function parseCsv(text: string, fileName: string): Workbook {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = [",", "\t", ";"].reduce((best, candidate) =>
    firstLine.split(candidate).length > firstLine.split(best).length ? candidate : best,
  );
  const cells: Record<string, string> = {};
  let row = 1;
  let col = 0;
  let field = "";
  let quoted = false;
  const put = () => {
    if (field !== "" && row <= MAX_ROWS && col < MAX_COLS) cells[`${colLetters(col)}${row}`] = asText(field);
    field = "";
  };
  for (let i = 0; i < text.length && row <= MAX_ROWS; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) {
      put();
      col += 1;
    } else if (char === "\n" || char === "\r") {
      put();
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row += 1;
      col = 0;
    } else field += char;
  }
  put();
  return { fileName, sheets: [{ name: fileName.replace(/\.[^.]+$/, "").slice(0, 31) || "Sheet1", widths: [], cells, styles: {} }] };
}

/** 고른 파일을 읽어 이 브라우저에 저장. 실패하면 FileImportError(안내 문구) */
export async function importMyFile(file: File): Promise<StoredFile> {
  if (file.size > MAX_FILE_BYTES) throw new FileImportError("5MB보다 작은 파일만 불러올 수 있어요.");
  const name = cleanName(file.name);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let workbook: Workbook;
  if (/\.csv$/i.test(name) || /\.txt$/i.test(name)) workbook = parseCsv(decodeText(bytes), name);
  else if (/\.xlsx$/i.test(name) || /\.xlsm$/i.test(name)) {
    if (typeof DecompressionStream === "undefined") throw new FileImportError("이 브라우저에서는 엑셀 파일을 읽을 수 없어요.");
    workbook = await parseXlsx(bytes, name);
  } else throw new FileImportError(".xlsx 또는 .csv 파일만 불러올 수 있어요. (.xls는 엑셀에서 .xlsx로 저장해 주세요)");
  const stored: StoredFile = { ...workbook, stamp: String(Date.now()) };
  saveMyFile(stored);
  return stored;
}

// ------------------------------------------------------------------ docx(Word 위장 화면)

const MAX_DOC_TEXT = 190_000;

/**
 * Word 파일(.docx)에서 글만 뽑는다: 제목은 '# ', '## ', '### ', 목록은 '- ', 나머지는 문단 한 줄.
 * 원본 파일은 서버로 보내지 않는다(뽑은 글만 계정에 저장).
 */
export async function readDocx(file: File): Promise<string> {
  if (file.size > MAX_FILE_BYTES) throw new FileImportError("5MB보다 작은 파일만 불러올 수 있어요.");
  if (!/\.docx$/i.test(file.name)) throw new FileImportError("Word 파일(.docx)만 불러올 수 있어요. (.doc는 Word에서 .docx로 저장해 주세요)");
  if (typeof DecompressionStream === "undefined") throw new FileImportError("이 브라우저에서는 Word 파일을 읽을 수 없어요.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entry = readEntries(bytes, "Word 파일(.docx)이 아니에요.").find((item) => item.name === "word/document.xml");
  if (!entry) throw new FileImportError("Word 파일(.docx)이 아니에요.");
  const doc = xml(await readEntry(bytes, entry));
  const lines: string[] = [];
  for (const paragraph of all(doc, "p")) {
    let text = "";
    for (const node of Array.from(paragraph.getElementsByTagNameNS("*", "*"))) {
      if (node.localName === "t") text += node.textContent ?? "";
      else if (node.localName === "tab") text += " ";
      else if (node.localName === "br") text += " ";
    }
    text = text.replace(/\s+/g, " ").trim();
    if (!text) {
      if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
      continue;
    }
    const styleNode = all(paragraph, "pStyle")[0];
    const style = styleNode ? (Array.from(styleNode.attributes).find((item) => item.localName === "val")?.value ?? "") : "";
    // 문서 제목(Title)은 '# ', 제목 1은 '## ', 제목 2 이하는 '### '
    const heading = Number(/(?:heading|제목)\s*([1-9])/i.exec(style)?.[1] ?? 0);
    const level = /^(title|제목)$/i.test(style) ? 1 : heading > 0 ? Math.min(heading + 1, 3) : 0;
    const listed = all(paragraph, "numPr").length > 0 || /list/i.test(style);
    lines.push(level > 0 ? `${"#".repeat(level)} ${text}` : listed ? `- ${text}` : text);
    if (lines.join("\n").length > MAX_DOC_TEXT) break;
  }
  const result = lines.join("\n").trim().slice(0, MAX_DOC_TEXT);
  if (!result) throw new FileImportError("문서에서 글을 찾지 못했어요.");
  return result;
}

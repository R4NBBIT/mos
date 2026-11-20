// 위장 화면의 작은 수식 계산기. 셀 값은 사용자가 입력한 글자 그대로 두고, 보여 줄 때 계산한다.
// 지원: 숫자·"글자"·셀(A1)·범위(A1:B3), + - * / & 괄호, 100%, 함수 SUM AVERAGE COUNT COUNTA MIN MAX ROUND COUNTIF SUMIF
// eval·Function은 쓰지 않는다(직접 만든 파서).

export interface Evaluated {
  value: number | string | null;
  /** #VALUE!, #REF!, #DIV/0!, #NAME?, #순환! 같은 오류 */
  error?: string;
  /** 백분율로 보여 줄 값 */
  pct?: boolean;
}

export type CellGetter = (address: string) => Evaluated;

const MAX_COLS = 26 * 2;

export function colName(index: number): string {
  let name = "";
  let n = index + 1;
  while (n > 0) {
    const rest = (n - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

export function parseAddress(text: string): { col: number; row: number } | null {
  const match = /^([A-Z]{1,2})(\d{1,4})$/.exec(text.toUpperCase());
  if (!match) return null;
  const letters = match[1] ?? "";
  let col = 0;
  for (const char of letters) col = col * 26 + (char.charCodeAt(0) - 64);
  const row = Number(match[2]);
  if (col < 1 || col > MAX_COLS || row < 1) return null;
  return { col: col - 1, row };
}

export function address(col: number, row: number): string {
  return `${colName(col)}${row}`;
}

/** 수식이 아닌 입력: 1,200 → 1200, 80% → 0.8(백분율), 나머지는 글자 */
export function literal(raw: string): Evaluated {
  const text = raw.trim();
  if (text === "") return { value: null };
  if (text.startsWith("'")) return { value: text.slice(1) }; // 엑셀처럼 '로 시작하면 글자 그대로
  const percent = /^(-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)%$/.exec(text);
  if (percent) return { value: Number((percent[1] ?? "").replace(/,/g, "")) / 100, pct: true };
  if (/^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(text)) return { value: Number(text.replace(/,/g, "")) };
  return { value: raw };
}

class FormulaError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

type Token =
  | { kind: "num"; value: number; pct: boolean }
  | { kind: "str"; value: string }
  | { kind: "ref"; value: string }
  | { kind: "name"; value: string }
  | { kind: "op"; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i] ?? "";
    if (/\s/.test(char)) {
      i += 1;
      continue;
    }
    const rest = source.slice(i);
    const number = /^\d+(?:\.\d+)?%?/.exec(rest);
    if (number) {
      const text = number[0];
      const pct = text.endsWith("%");
      tokens.push({ kind: "num", value: Number(pct ? text.slice(0, -1) : text) / (pct ? 100 : 1), pct });
      i += text.length;
      continue;
    }
    if (char === '"') {
      const end = source.indexOf('"', i + 1);
      if (end < 0) throw new FormulaError("#VALUE!");
      tokens.push({ kind: "str", value: source.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    const word = /^[A-Za-z]+\d*/.exec(rest);
    if (word) {
      const text = word[0].toUpperCase();
      if (/\d$/.test(text)) tokens.push({ kind: "ref", value: text });
      else tokens.push({ kind: "name", value: text });
      i += text.length;
      continue;
    }
    if ("+-*/&(),:".includes(char)) {
      tokens.push({ kind: "op", value: char });
      i += 1;
      continue;
    }
    throw new FormulaError("#NAME?");
  }
  return tokens;
}

type Value = Evaluated | { range: Evaluated[] };

function isRange(value: Value): value is { range: Evaluated[] } {
  return "range" in value;
}

function toNumber(value: Evaluated): number {
  if (value.error) throw new FormulaError(value.error);
  if (value.value === null) return 0;
  if (typeof value.value === "number") return value.value;
  const parsed = literal(value.value);
  if (typeof parsed.value === "number") return parsed.value;
  throw new FormulaError("#VALUE!");
}

function toText(value: Evaluated): string {
  if (value.error) throw new FormulaError(value.error);
  if (value.value === null) return "";
  if (typeof value.value === "number") return formatNumber(value.value, Boolean(value.pct));
  return value.value;
}

function single(value: Value): Evaluated {
  if (isRange(value)) {
    if (value.range.length === 1 && value.range[0]) return value.range[0];
    throw new FormulaError("#VALUE!");
  }
  return value;
}

function numbersOf(values: Value[]): { numbers: number[]; pct: boolean } {
  const numbers: number[] = [];
  let pct = false;
  for (const item of values) {
    if (isRange(item)) {
      for (const cell of item.range) {
        if (cell.error) throw new FormulaError(cell.error);
        if (typeof cell.value === "number") {
          numbers.push(cell.value);
          pct = pct || Boolean(cell.pct);
        }
      }
    } else {
      numbers.push(toNumber(item));
      pct = pct || Boolean(item.pct);
    }
  }
  return { numbers, pct };
}

function matches(cell: Evaluated, criterion: Evaluated): boolean {
  const text = criterion.value === null ? "" : String(criterion.value);
  const compare = /^(>=|<=|<>|>|<|=)?(.*)$/.exec(text);
  const op = compare?.[1] ?? "=";
  const target = compare?.[2] ?? "";
  const targetNumber = literal(target);
  if (typeof targetNumber.value === "number" && typeof cell.value === "number") {
    const a = cell.value;
    const b = targetNumber.value;
    return op === ">" ? a > b : op === "<" ? a < b : op === ">=" ? a >= b : op === "<=" ? a <= b : op === "<>" ? a !== b : a === b;
  }
  const cellText = cell.value === null ? "" : String(cell.value);
  if (op === "<>") return cellText !== target;
  if (op === "=") return cellText === target;
  return false;
}

const FUNCTIONS: Record<string, (args: Value[]) => Evaluated> = {
  SUM: (args) => {
    const { numbers, pct } = numbersOf(args);
    return { value: numbers.reduce((a, b) => a + b, 0), pct };
  },
  AVERAGE: (args) => {
    const { numbers, pct } = numbersOf(args);
    if (numbers.length === 0) throw new FormulaError("#DIV/0!");
    return { value: numbers.reduce((a, b) => a + b, 0) / numbers.length, pct };
  },
  COUNT: (args) => ({ value: numbersOf(args).numbers.length }),
  COUNTA: (args) => ({
    value: args.reduce(
      (total, item) =>
        total + (isRange(item) ? item.range.filter((cell) => cell.value !== null).length : item.value !== null ? 1 : 0),
      0,
    ),
  }),
  MIN: (args) => {
    const { numbers, pct } = numbersOf(args);
    return { value: numbers.length ? Math.min(...numbers) : 0, pct };
  },
  MAX: (args) => {
    const { numbers, pct } = numbersOf(args);
    return { value: numbers.length ? Math.max(...numbers) : 0, pct };
  },
  ROUND: (args) => {
    const [first, second] = args;
    if (!first) throw new FormulaError("#VALUE!");
    const value = single(first);
    const digits = second ? Math.trunc(toNumber(single(second))) : 0;
    const factor = 10 ** Math.max(-10, Math.min(10, digits));
    return { value: Math.round(toNumber(value) * factor) / factor, pct: value.pct };
  },
  COUNTIF: (args) => {
    const [range, criterion] = args;
    if (!range || !criterion || !isRange(range)) throw new FormulaError("#VALUE!");
    const target = single(criterion);
    return { value: range.range.filter((cell) => matches(cell, target)).length };
  },
  SUMIF: (args) => {
    const [range, criterion, sumRange] = args;
    if (!range || !criterion || !isRange(range)) throw new FormulaError("#VALUE!");
    const target = single(criterion);
    const values = sumRange && isRange(sumRange) ? sumRange.range : range.range;
    let total = 0;
    range.range.forEach((cell, index) => {
      const value = values[index];
      if (matches(cell, target) && value && typeof value.value === "number") total += value.value;
    });
    return { value: total };
  },
};

const MAX_RANGE_CELLS = 5000;

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  private readonly get: CellGetter;

  constructor(tokens: Token[], get: CellGetter) {
    this.tokens = tokens;
    this.get = get;
  }

  parse(): Value {
    const value = this.concat();
    if (this.pos < this.tokens.length) throw new FormulaError("#VALUE!");
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private takeOp(op: string): boolean {
    const token = this.peek();
    if (token?.kind === "op" && token.value === op) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private concat(): Value {
    let left = this.sum();
    while (this.takeOp("&")) {
      const right = this.sum();
      left = { value: toText(single(left)) + toText(single(right)) };
    }
    return left;
  }

  private sum(): Value {
    let left = this.product();
    for (;;) {
      if (this.takeOp("+")) {
        const a = single(left);
        const b = single(this.product());
        left = { value: toNumber(a) + toNumber(b), pct: Boolean(a.pct || b.pct) };
      } else if (this.takeOp("-")) {
        const a = single(left);
        const b = single(this.product());
        left = { value: toNumber(a) - toNumber(b), pct: Boolean(a.pct || b.pct) };
      } else return left;
    }
  }

  private product(): Value {
    let left = this.unary();
    for (;;) {
      if (this.takeOp("*")) {
        left = { value: toNumber(single(left)) * toNumber(single(this.unary())) };
      } else if (this.takeOp("/")) {
        const divisor = toNumber(single(this.unary()));
        if (divisor === 0) throw new FormulaError("#DIV/0!");
        left = { value: toNumber(single(left)) / divisor };
      } else return left;
    }
  }

  private unary(): Value {
    if (this.takeOp("-")) {
      const value = single(this.unary());
      return { value: -toNumber(value), pct: value.pct };
    }
    if (this.takeOp("+")) return this.unary();
    return this.primary();
  }

  private primary(): Value {
    const token = this.peek();
    if (!token) throw new FormulaError("#VALUE!");
    this.pos += 1;
    if (token.kind === "num") return { value: token.value, pct: token.pct };
    if (token.kind === "str") return { value: token.value };
    if (token.kind === "op" && token.value === "(") {
      const value = this.concat();
      if (!this.takeOp(")")) throw new FormulaError("#VALUE!");
      return value;
    }
    if (token.kind === "ref") {
      const start = parseAddress(token.value);
      if (!start) throw new FormulaError("#REF!");
      if (this.takeOp(":")) {
        const endToken = this.peek();
        const end = endToken?.kind === "ref" ? parseAddress(endToken.value) : null;
        if (!end) throw new FormulaError("#REF!");
        this.pos += 1;
        const cells: Evaluated[] = [];
        const [c1, c2] = [Math.min(start.col, end.col), Math.max(start.col, end.col)];
        const [r1, r2] = [Math.min(start.row, end.row), Math.max(start.row, end.row)];
        if ((c2 - c1 + 1) * (r2 - r1 + 1) > MAX_RANGE_CELLS) throw new FormulaError("#REF!");
        for (let row = r1; row <= r2; row += 1) {
          for (let col = c1; col <= c2; col += 1) cells.push(this.get(address(col, row)));
        }
        return { range: cells };
      }
      return this.get(address(start.col, start.row));
    }
    if (token.kind === "name") {
      const fn = FUNCTIONS[token.value];
      if (!fn || !this.takeOp("(")) throw new FormulaError("#NAME?");
      const args: Value[] = [];
      if (!this.takeOp(")")) {
        do args.push(this.concat());
        while (this.takeOp(","));
        if (!this.takeOp(")")) throw new FormulaError("#VALUE!");
      }
      return fn(args);
    }
    throw new FormulaError("#VALUE!");
  }
}

/** 셀 하나의 입력(raw)을 계산. '='로 시작하면 수식 */
export function evaluate(raw: string, get: CellGetter): Evaluated {
  if (!raw.startsWith("=")) return literal(raw);
  try {
    const result = single(new Parser(tokenize(raw.slice(1)), get).parse());
    if (typeof result.value === "number" && !Number.isFinite(result.value)) return { value: null, error: "#NUM!" };
    return result;
  } catch (caught) {
    if (caught instanceof FormulaError) return { value: null, error: caught.code };
    return { value: null, error: "#VALUE!" };
  }
}

/** 시트 하나의 계산기. 같은 그리기 안에서는 결과를 기억하고, 순환 참조는 오류로 */
export function makeCalculator(rawOf: (address: string) => string): CellGetter {
  const cache = new Map<string, Evaluated>();
  const visiting = new Set<string>();
  const get: CellGetter = (key) => {
    const cached = cache.get(key);
    if (cached) return cached;
    if (visiting.has(key)) return { value: null, error: "#순환!" };
    visiting.add(key);
    const result = evaluate(rawOf(key), get);
    visiting.delete(key);
    cache.set(key, result);
    return result;
  };
  return get;
}

export function formatNumber(value: number, pct: boolean, fmt?: string): string {
  if (fmt === "pct" || (pct && fmt !== "num")) {
    return `${(Math.round(value * 1000) / 10).toLocaleString("ko-KR")}%`;
  }
  return value.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
}

export function display(result: Evaluated, fmt?: string): string {
  if (result.error) return result.error;
  if (result.value === null) return "";
  if (typeof result.value === "number") return formatNumber(result.value, Boolean(result.pct), fmt);
  return result.value;
}

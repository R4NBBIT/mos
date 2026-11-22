// 할 일 입력칸 글자에서 날짜, 시각, 장소(@), 메모(//)를 떼어 낸다(기능명세서 TODO-13, 14, 15).
// AI 없이 규칙으로만. 확실하지 않은 것은 추측하지 않는다: 1~12시를 오전, 오후 없이 쓰면 물어본다.
// 테스트(node --test)에서 바로 읽을 수 있게 다른 파일을 가져오지 않는다.

export interface ParsedTodo {
  /** 떼어 내고 남은 이름 */
  title: string;
  /** 정해진 날짜(YYYY-MM-DD). 없으면 지금 보는 날 */
  day: string | null;
  /** HH:MM. 물어봐야 하면 null + ask */
  time: string | null;
  /** 1~12시를 오전, 오후 없이 썼을 때: 고를 두 시각 */
  ask: { am: string; pm: string; label: string } | null;
  place: string | null;
  memo: string | null;
  /** 무엇이든 떼어 냈는지 */
  found: boolean;
}

const WEEKDAYS = "일월화수목금토";
const pad = (value: number) => String(value).padStart(2, "0");

function key(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function fromKey(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year ?? 2000, (month ?? 1) - 1, day ?? 1, 12);
}

function plus(value: string, days: number): string {
  const date = fromKey(value);
  date.setDate(date.getDate() + days);
  return key(date);
}

/** 실제로 있는 날짜만(2월 30일 같은 것은 null) */
function makeDay(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day, 12);
  return date.getMonth() === month - 1 ? key(date) : null;
}

// 날짜, 시각 말 뒤에 붙을 수 있는 말(떼어 낼 때 같이 뺀다)
const TAIL = "(?:까지|부터|에|에는|쯤)?";
// 앞은 맨 앞 또는 공백, 뒤는 끝 또는 공백(낱말 중간은 건드리지 않는다)
const wrap = (body: string) => new RegExp(`(^|\\s)${body}${TAIL}(?=\\s|$)`, "u");

const DATE_RULES: { re: RegExp; resolve: (m: RegExpExecArray, today: string) => string | null }[] = [
  {
    re: wrap("(\\d{4})-(\\d{1,2})-(\\d{1,2})"),
    resolve: (m, _today) => makeDay(Number(m[2]), Number(m[3]), Number(m[4])),
  },
  {
    re: wrap("(\\d{1,2})월\\s?(\\d{1,2})일"),
    resolve: (m, today) => makeDay(fromKey(today).getFullYear(), Number(m[2]), Number(m[3])),
  },
  {
    re: wrap("(\\d{1,2})/(\\d{1,2})"),
    resolve: (m, today) => makeDay(fromKey(today).getFullYear(), Number(m[2]), Number(m[3])),
  },
  {
    re: wrap("(오늘|내일|모레|글피|어제)"),
    resolve: (m, today) => plus(today, { 오늘: 0, 내일: 1, 모레: 2, 글피: 3, 어제: -1 }[m[2] as "오늘"] ?? 0),
  },
  {
    re: wrap("(이번\\s?주|다음\\s?주|담주|다다음\\s?주)\\s?([일월화수목금토])요일?"),
    resolve: (m, today) => {
      const words = (m[2] ?? "").replace(/\s/g, "");
      const weeks = words === "이번주" ? 0 : words === "다다음주" ? 2 : 1;
      const sunday = plus(today, -fromKey(today).getDay()); // 한 주는 일요일 시작
      return plus(sunday, weeks * 7 + WEEKDAYS.indexOf(m[3] ?? "일"));
    },
  },
  {
    re: wrap("([일월화수목금토])요일"),
    resolve: (m, today) => {
      // 오늘부터 가장 가까운 그 요일(오늘이 그 요일이면 오늘)
      const want = WEEKDAYS.indexOf(m[2] ?? "일");
      return plus(today, (want - fromKey(today).getDay() + 7) % 7);
    },
  },
  {
    re: wrap("(\\d{1,2})일"),
    resolve: (m, today) => {
      // 이번 달 그날, 이미 지났으면 다음 달
      const now = fromKey(today);
      const day = Number(m[2]);
      const here = makeDay(now.getFullYear(), now.getMonth() + 1, day);
      if (here && here >= today) return here;
      const next = new Date(now.getFullYear(), now.getMonth() + 1, 1, 12);
      return makeDay(next.getFullYear(), next.getMonth() + 1, day);
    },
  },
];

type TimeResult = { time: string } | { ask: { am: string; pm: string; label: string } };

const MORNING = ["오전", "아침", "새벽"];
const EVENING = ["오후", "저녁", "밤"];

const TIME_RULES: { re: RegExp; resolve: (m: RegExpExecArray) => TimeResult | null }[] = [
  {
    re: wrap("(정오|자정)"),
    resolve: (m) => ({ time: m[2] === "정오" ? "12:00" : "00:00" }),
  },
  {
    re: wrap("(?:(오전|오후|아침|낮|저녁|밤|새벽)\\s?)?(\\d{1,2})시(?:\\s?(반|(\\d{1,2})분))?"),
    resolve: (m) => clock(m[2], Number(m[3]), m[4] === "반" ? 30 : m[5] ? Number(m[5]) : 0, false),
  },
  {
    re: wrap("(?:(오전|오후|아침|낮|저녁|밤|새벽)\\s?)?(\\d{1,2}):(\\d{2})"),
    // 03:30처럼 앞에 0을 붙여 쓰면 24시간 표기로 본다
    resolve: (m) => clock(m[2], Number(m[3]), Number(m[4]), (m[3] ?? "").length === 2),
  },
];

function clock(word: string | undefined, hour: number, minute: number, twentyFour: boolean): TimeResult | null {
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;
  const at = (h: number) => `${pad(h)}:${pad(minute)}`;
  if (word && MORNING.includes(word)) {
    if (hour > 12) return null;
    return { time: at(hour === 12 ? 0 : hour) };
  }
  if (word && EVENING.includes(word)) {
    if (hour > 12) return { time: at(hour) }; // 오후 15시처럼 써도 15:00
    if (word === "밤" && hour === 12) return { time: at(0) };
    return { time: at(hour === 12 ? 12 : hour + 12) };
  }
  if (word === "낮") {
    if (hour > 12) return null;
    return { time: at(hour >= 1 && hour <= 6 ? hour + 12 : hour) };
  }
  if (hour === 0 || hour >= 13 || twentyFour) return { time: at(hour) };
  // 1~12시, 오전 오후 없음: 물어본다
  const am = at(hour === 12 ? 0 : hour);
  const pm = at(hour === 12 ? 12 : hour + 12);
  return { ask: { am, pm, label: minute ? `${hour}시 ${minute}분` : `${hour}시` } };
}

function cut(text: string, match: RegExpExecArray): string {
  const start = match.index + (match[1]?.length ?? 0);
  return `${text.slice(0, start)} ${text.slice(match.index + match[0].length)}`;
}

const tidy = (text: string) => text.replace(/\s+/g, " ").trim();

export function parseWhen(raw: string, today: string): ParsedTodo {
  const plain: ParsedTodo = { title: tidy(raw), day: null, time: null, ask: null, place: null, memo: null, found: false };
  let text = raw;
  let memo: string | null = null;
  let place: string | null = null;

  // 메모: 맨 앞 또는 공백 뒤의 // 부터 끝까지(http:// 같은 주소는 건드리지 않음)
  const memoAt = text.search(/(^|\s)\/\//);
  if (memoAt >= 0) {
    const mark = text.indexOf("//", memoAt);
    memo = tidy(text.slice(mark + 2)) || null;
    text = text.slice(0, mark);
  }
  // 장소: 맨 앞 또는 공백 뒤의 @ 부터 끝까지(메일 주소의 @는 건드리지 않음)
  const placeMatch = /(^|\s)@\s?(.+)$/u.exec(text);
  if (placeMatch?.[2]) {
    const value = tidy(placeMatch[2]);
    if (value && value.length <= 40) {
      place = value;
      text = text.slice(0, placeMatch.index + (placeMatch[1]?.length ?? 0));
    }
  }

  let day: string | null = null;
  for (const rule of DATE_RULES) {
    const match = rule.re.exec(text);
    if (!match) continue;
    const value = rule.resolve(match, today);
    if (value) {
      day = value;
      text = cut(text, match);
    }
    break;
  }

  let time: string | null = null;
  let ask: ParsedTodo["ask"] = null;
  for (const rule of TIME_RULES) {
    const match = rule.re.exec(text);
    if (!match) continue;
    const value = rule.resolve(match);
    if (value) {
      if ("time" in value) time = value.time;
      else ask = value.ask;
      text = cut(text, match);
    }
    break;
  }

  const title = tidy(text);
  const found = day !== null || time !== null || ask !== null || place !== null || memo !== null;
  if (!found) return plain;
  if (!title) return plain; // 이름이 남지 않으면 떼지 않고 쓴 그대로
  return { title, day, time, ask, place, memo, found };
}

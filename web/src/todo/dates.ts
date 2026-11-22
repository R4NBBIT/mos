// 날짜 글자(YYYY-MM-DD)는 이 기기 시간대 기준. 서버는 글자 그대로 저장한다
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

const pad = (value: number) => String(value).padStart(2, "0");

export function dayKey(value: Date): string {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

export function today(): string {
  return dayKey(new Date());
}

/** 글자 → 그날 낮 12시(서머타임 경계에서도 날짜가 밀리지 않게) */
export function fromKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year ?? 2000, (month ?? 1) - 1, day ?? 1, 12);
}

export function addDays(key: string, days: number): string {
  const value = fromKey(key);
  value.setDate(value.getDate() + days);
  return dayKey(value);
}

export function isDayKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && dayKey(fromKey(value)) === value;
}

/** 일요일로 시작하는 그 주의 7일 */
export function weekOf(key: string): string[] {
  const start = addDays(key, -fromKey(key).getDay());
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

/** 그 달 달력 칸(앞뒤 빈칸은 null), 일요일 시작 */
export function monthGrid(key: string): (string | null)[] {
  const value = fromKey(key);
  const first = new Date(value.getFullYear(), value.getMonth(), 1, 12);
  const last = new Date(value.getFullYear(), value.getMonth() + 1, 0, 12).getDate();
  const cells: (string | null)[] = Array.from({ length: first.getDay() }, () => null);
  for (let day = 1; day <= last; day += 1) cells.push(dayKey(new Date(value.getFullYear(), value.getMonth(), day, 12)));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export function monthStart(key: string): string {
  return `${key.slice(0, 8)}01`;
}

export function shiftMonth(key: string, months: number): string {
  const value = fromKey(monthStart(key));
  value.setMonth(value.getMonth() + months);
  return dayKey(value);
}

export function weekdayName(key: string): string {
  return WEEKDAYS[fromKey(key).getDay()] ?? "";
}

/** 11월 22일 토요일 */
export function longLabel(key: string): string {
  const value = fromKey(key);
  return `${value.getMonth() + 1}월 ${value.getDate()}일 ${weekdayName(key)}요일`;
}

export function monthLabel(key: string): string {
  const value = fromKey(key);
  return `${value.getFullYear()}년 ${value.getMonth() + 1}월`;
}

export const WEEKDAY_NAMES = WEEKDAYS;

/** 2026-11-22 → 2026. 11. 22. (일) */
export function dateWithWeekday(key: string): string {
  return `${key.slice(0, 4)}. ${Number(key.slice(5, 7))}. ${Number(key.slice(8, 10))}. (${weekdayName(key)})`;
}

/** 2026-11-23 → 11/23(월): TODO 줄에 붙는 짧은 날짜 */
export function shortDate(key: string): string {
  return `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}(${weekdayName(key)})`;
}

/** 15:00 → 15:00, 9:5 → 09:05 (24시간, 어디서나 HH:MM) */
export function timeLabel(time: string): string {
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  return `${pad(hour)}:${pad(minute)}`;
}

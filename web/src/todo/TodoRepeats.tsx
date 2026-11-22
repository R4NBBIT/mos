// 반복 할 일 화면(#/todo/repeats, 2026-11-22 사용자 요청): 정해 둔 규칙대로 날마다 자동으로 생기는 할 일.
// 기간(시작, 끝), 매일/평일/매주(요일 여러 개)/매달, 공휴일 빼기. 기간이 끝난 반복은 아래 '끝난 반복'에 모아 두고
// '새 기간 추가'로 다시 쓴다(같은 반복에 기간이 하나씩 쌓인다). 삭제는 휴지통 7일.
import { type ReactNode, useCallback, useEffect, useState } from "react";
import BackIcon from "../BackIcon";
import SplitToggle from "../SplitToggle";
import { addDays, dateWithWeekday, timeLabel, today, WEEKDAY_NAMES } from "./dates";
import { CategoryDot } from "./TodoItems";
import {
  deleteRepeatSeries,
  fetchCategories,
  fetchRepeats,
  newRepeat,
  type NewRepeat,
  type RepeatPeriod,
  type RepeatRule,
  type RepeatSeries,
  type TodoCategory,
  todoErrorText,
  updateRepeat,
} from "./todoApi";
import "./todo.css";

const RULES: { value: RepeatRule; label: string }[] = [
  { value: "daily", label: "매일" },
  { value: "weekdays", label: "평일" },
  { value: "weekly", label: "매주" },
  { value: "monthly", label: "매달" },
];

function ruleText(period: RepeatPeriod): string {
  if (period.rule === "daily") return "매일";
  if (period.rule === "weekdays") return "평일마다";
  if (period.rule === "monthly") return `매달 ${Number(period.start_day.slice(8, 10))}일`;
  return `매주 ${period.weekdays.map((day) => WEEKDAY_NAMES[day]).join(" ")}`;
}

function periodText(start: string, end: string | null): string {
  return end ? `${dateWithWeekday(start)} ~ ${dateWithWeekday(end)}` : `${dateWithWeekday(start)}부터, 끝 날 없음`;
}

interface Draft {
  title: string;
  category_id: string;
  rule: RepeatRule;
  weekdays: number[];
  start_day: string;
  end_day: string;
  skip_holidays: boolean;
  time: string;
  place: string;
  memo: string;
}

function draftFrom(period: RepeatPeriod | null, categories: TodoCategory[]): Draft {
  if (!period) {
    const day = today();
    const weekday = new Date(`${day}T00:00:00`).getDay();
    return {
      title: "",
      category_id: categories[0]?.id ?? "",
      rule: "daily",
      weekdays: [weekday],
      start_day: day,
      end_day: "",
      skip_holidays: false,
      time: "",
      place: "",
      memo: "",
    };
  }
  return {
    title: period.title,
    category_id: period.category_id,
    rule: period.rule,
    weekdays: period.weekdays.length ? period.weekdays : [new Date(`${period.start_day}T00:00:00`).getDay()],
    start_day: period.start_day,
    end_day: period.end_day ?? "",
    skip_holidays: period.skip_holidays,
    time: period.time ?? "",
    place: period.place ?? "",
    memo: period.memo,
  };
}

function Field({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="todo-rep-field">
      <span className="todo-rep-name">{name}</span>
      <div className="todo-rep-value">{children}</div>
    </div>
  );
}

/** 반복 만들기와 수정(규칙, 기간, 이름, 카테고리, 시각, 장소, 메모) */
function RepeatEditor({
  categories,
  period,
  seriesId,
  minStart,
  onDone,
  onCancel,
}: {
  categories: TodoCategory[];
  period: RepeatPeriod | null;
  /** 끝난 반복에 새 기간 더하기 */
  seriesId?: string;
  minStart?: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const adding = Boolean(seriesId);
  const [draft, setDraft] = useState<Draft>(() => {
    const base = draftFrom(period, categories);
    if (adding) return { ...base, start_day: minStart && minStart > today() ? minStart : today(), end_day: "" };
    return base;
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (changes: Partial<Draft>) => setDraft((current) => ({ ...current, ...changes }));
  const toggleDay = (day: number) =>
    set({
      weekdays: draft.weekdays.includes(day)
        ? draft.weekdays.filter((value) => value !== day)
        : [...draft.weekdays, day].sort(),
    });
  const save = async () => {
    if (!draft.title.trim()) {
      setError("이름을 써 주세요.");
      return;
    }
    if (draft.rule === "weekly" && draft.weekdays.length === 0) {
      setError("요일을 하나 이상 골라 주세요.");
      return;
    }
    if (draft.end_day && draft.end_day < draft.start_day) {
      setError("끝 날은 시작 날보다 뒤여야 해요.");
      return;
    }
    setBusy(true);
    try {
      const common = {
        title: draft.title.trim(),
        category_id: draft.category_id,
        rule: draft.rule,
        weekdays: draft.rule === "weekly" ? draft.weekdays : undefined,
        end_day: draft.end_day || null,
        skip_holidays: draft.skip_holidays,
        time: draft.time || null,
        place: draft.place.trim() || null,
        memo: draft.memo,
      };
      if (period && !adding) {
        await updateRepeat(period.id, { ...common, start_day: draft.start_day });
      } else {
        const input: NewRepeat = { ...common, start_day: draft.start_day };
        if (seriesId) input.series_id = seriesId;
        await newRepeat(input);
      }
      onDone();
    } catch (failure) {
      setError(todoErrorText(failure));
    } finally {
      setBusy(false);
    }
  };
  const open = categories.filter((category) => !category.closed);
  return (
    <div className="todo-rep-editor">
      {!adding && (
        <>
          <Field name="이름">
            <input value={draft.title} maxLength={100} autoFocus onChange={(event) => set({ title: event.target.value })} />
          </Field>
          <Field name="카테고리">
            <select value={draft.category_id} onChange={(event) => set({ category_id: event.target.value })}>
              {open.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </Field>
          <Field name="반복">
            <div className="todo-segment todo-segment-full" role="radiogroup" aria-label="반복 규칙">
              {RULES.map((rule) => (
                <button
                  key={rule.value}
                  type="button"
                  role="radio"
                  aria-checked={draft.rule === rule.value}
                  className={draft.rule === rule.value ? "todo-segment-on" : undefined}
                  onClick={() => set({ rule: rule.value })}
                >
                  {rule.label}
                </button>
              ))}
            </div>
          </Field>
          {draft.rule === "weekly" && (
            <Field name="요일">
              <div className="todo-rep-days" role="group" aria-label="요일(여러 개)">
                {WEEKDAY_NAMES.map((name, day) => (
                  <button
                    key={name}
                    type="button"
                    aria-pressed={draft.weekdays.includes(day)}
                    className={draft.weekdays.includes(day) ? "todo-rep-day todo-rep-day-on" : "todo-rep-day"}
                    onClick={() => toggleDay(day)}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </Field>
          )}
          {draft.rule === "monthly" && (
            <p className="todo-field-help todo-rep-note">시작 날과 같은 날짜마다(31일이면 짧은 달은 마지막 날).</p>
          )}
        </>
      )}
      <Field name="기간">
        <div className="todo-rep-period">
          <input
            type="date"
            value={draft.start_day}
            min={adding ? minStart : undefined}
            aria-label="시작 날"
            onChange={(event) => set({ start_day: event.target.value })}
          />
          <span>~</span>
          <input
            type="date"
            value={draft.end_day}
            min={draft.start_day}
            aria-label="끝 날"
            onChange={(event) => set({ end_day: event.target.value })}
          />
          {draft.end_day && (
            <button type="button" className="todo-text-button" onClick={() => set({ end_day: "" })}>
              끝 날 없음
            </button>
          )}
        </div>
        {!draft.end_day && <p className="todo-field-help">끝 날을 정하지 않으면 계속 반복해요.</p>}
      </Field>
      {!adding && (
        <>
          <Field name="공휴일">
            <label className="todo-switch">
              <input
                type="checkbox"
                role="switch"
                checked={draft.skip_holidays}
                onChange={(event) => set({ skip_holidays: event.target.checked })}
              />
              <span className="todo-switch-track" aria-hidden="true" />
              <span>{draft.skip_holidays ? "공휴일에는 빼기" : "공휴일에도 넣기"}</span>
            </label>
          </Field>
          <Field name="시각">
            <input type="time" value={draft.time} onChange={(event) => set({ time: event.target.value })} />
          </Field>
          <Field name="장소">
            <input value={draft.place} maxLength={40} onChange={(event) => set({ place: event.target.value })} />
          </Field>
          <Field name="메모">
            <textarea value={draft.memo} maxLength={1000} rows={2} onChange={(event) => set({ memo: event.target.value })} />
          </Field>
        </>
      )}
      {error && <p className="todo-error">{error}</p>}
      <div className="todo-cat-actions">
        <span />
        <div className="todo-cat-actions-main">
          <button type="button" className="todo-small-button" onClick={onCancel}>
            취소
          </button>
          <button type="button" className="todo-small-button todo-primary" disabled={busy} onClick={() => void save()}>
            {adding ? "기간 추가" : period ? "저장" : "만들기"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SeriesCard({
  series,
  categories,
  editing,
  onEdit,
  onChanged,
}: {
  series: RepeatSeries;
  categories: TodoCategory[];
  editing: "edit" | "period" | null;
  onEdit: (mode: "edit" | "period" | null) => void;
  onChanged: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState("");
  const current = series.current;
  const category = categories.find((item) => item.id === current.category_id);
  const last = series.periods[series.periods.length - 1];
  const meta = [ruleText(current), current.time ? timeLabel(current.time) : "", current.place ?? ""].filter(Boolean).join(", ");
  return (
    <div className={series.ended ? "todo-cat-item todo-rep-card todo-cat-closed" : "todo-cat-item todo-rep-card"}>
      <div className="todo-cat-line">
        {category && <CategoryDot color={category.color} />}
        <span className="todo-rep-title">
          <span className="todo-cat-name">{current.title}</span>
          <span className="todo-rep-meta">{meta}</span>
        </span>
        {current.skip_holidays && <span className="todo-cat-scope">공휴일 빼기</span>}
        {editing === null && !asking && (
          <>
            {series.ended ? (
              <button type="button" className="todo-small-button todo-primary" onClick={() => onEdit("period")}>
                새 기간 추가
              </button>
            ) : (
              <button type="button" className="todo-small-button" onClick={() => onEdit("edit")}>
                수정
              </button>
            )}
            <button type="button" className="todo-text-button todo-danger-text" onClick={() => setAsking(true)}>
              삭제
            </button>
          </>
        )}
      </div>
      <ul className="todo-rep-periods">
        {series.periods.map((period) => (
          <li key={period.id}>
            {periodText(period.start_day, period.end_day)}
            {!period.end_day && <span className="todo-rep-none">기간을 정해 두지 않았어요</span>}
          </li>
        ))}
      </ul>
      {asking && (
        <div className="todo-confirm" role="alertdialog" aria-label="반복 삭제 확인">
          <span>'{current.title}' 반복을 삭제할까요? 이미 생긴 회차도 같이 지워지고, 휴지통에서 7일 동안 되살릴 수 있어요.</span>
          <div className="todo-confirm-buttons">
            <button type="button" className="todo-small-button" onClick={() => setAsking(false)}>
              취소
            </button>
            <button
              type="button"
              className="todo-small-button todo-danger"
              onClick={() =>
                void deleteRepeatSeries(series.id)
                  .then(onChanged)
                  .catch((failure: unknown) => setError(todoErrorText(failure)))
              }
            >
              삭제
            </button>
          </div>
        </div>
      )}
      {error && <p className="todo-error">{error}</p>}
      {editing && (
        <RepeatEditor
          categories={categories}
          period={current}
          seriesId={editing === "period" ? series.id : undefined}
          minStart={editing === "period" && last?.end_day ? addDays(last.end_day, 1) : undefined}
          onDone={() => {
            onEdit(null);
            onChanged();
          }}
          onCancel={() => onEdit(null)}
        />
      )}
    </div>
  );
}

export default function TodoRepeats({
  showBack,
  onBack,
  menu,
  onChanged,
}: {
  showBack: boolean;
  onBack: () => void;
  menu: ReactNode;
  onChanged?: () => void;
}) {
  const [series, setSeries] = useState<RepeatSeries[] | null>(null);
  const [categories, setCategories] = useState<TodoCategory[]>([]);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<{ id: string; mode: "edit" | "period" } | null>(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => {
    Promise.all([fetchRepeats(today()), fetchCategories()])
      .then(([repeats, cats]) => {
        setSeries(repeats.series);
        setCategories(cats.categories);
      })
      .catch(() => setFailed(true));
  }, []);
  useEffect(load, [load]);
  const changed = () => {
    load();
    onChanged?.();
  };
  const active = series?.filter((item) => !item.ended) ?? [];
  const ended = series?.filter((item) => item.ended) ?? [];
  const card = (item: RepeatSeries) => (
    <SeriesCard
      key={item.id}
      series={item}
      categories={categories}
      editing={editing?.id === item.id ? editing.mode : null}
      onEdit={(mode) => setEditing(mode ? { id: item.id, mode } : null)}
      onChanged={changed}
    />
  );
  return (
    <div className="room todo-room">
      <header className="room-header">
        <SplitToggle />
        {showBack && (
          <button type="button" className="back-button" onClick={onBack} aria-label="할 일로">
            <BackIcon />
          </button>
        )}
        <div className="room-title">
          <strong>반복</strong>
          <span className="room-sub">정해 둔 날마다 자동으로 생기는 할 일</span>
        </div>
        {!showBack && (
          <div className="header-tools">
            <button type="button" className="header-tool" onClick={onBack}>
              <span className="header-tool-label todo-tool-always">할 일로</span>
            </button>
          </div>
        )}
        {menu}
      </header>
      <div className="todo-cat-body">
        {series === null && <p className="list-note">{failed ? "불러오지 못했어요." : "불러오는 중…"}</p>}
        {series && active.length === 0 && !creating && <p className="todo-field-help">반복 중인 할 일이 없어요.</p>}
        {active.map(card)}
        {series &&
          (creating ? (
            <div className="todo-cat-item">
              <RepeatEditor
                categories={categories}
                period={null}
                onDone={() => {
                  setCreating(false);
                  changed();
                }}
                onCancel={() => setCreating(false)}
              />
            </div>
          ) : (
            <button type="button" className="todo-cat-add" aria-label="새 반복" onClick={() => setCreating(true)}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          ))}
        {ended.length > 0 && (
          <section className="todo-cat-section" aria-label="끝난 반복">
            <h2 className="todo-cat-section-title">끝난 반복</h2>
            <p className="todo-field-help">기간이 끝난 반복이에요. '새 기간 추가'로 다시 쓸 수 있어요.</p>
            {ended.map(card)}
          </section>
        )}
      </div>
    </div>
  );
}

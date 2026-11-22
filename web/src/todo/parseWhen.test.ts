// node --test 로 돌린다(기능명세서 TODO-13 예시 표 그대로). 오늘은 2026-11-22 일요일
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWhen } from "./parseWhen.ts";

const TODAY = "2026-11-22";
const pick = (text: string) => {
  const r = parseWhen(text, TODAY);
  return { title: r.title, day: r.day, time: r.time, ask: r.ask ? [r.ask.am, r.ask.pm] : null, place: r.place, memo: r.memo };
};

test("명세서 예시", () => {
  assert.deepEqual(pick("내일 3시 치과"), { title: "치과", day: "2026-11-23", time: null, ask: ["03:00", "15:00"], place: null, memo: null });
  assert.deepEqual(pick("내일 오후 3시 치과"), { title: "치과", day: "2026-11-23", time: "15:00", ask: null, place: null, memo: null });
  assert.equal(pick("금요일까지 보고서").day, "2026-11-27");
  assert.equal(pick("금요일까지 보고서").title, "보고서");
  assert.deepEqual(pick("모레 15시 회의"), { title: "회의", day: "2026-11-24", time: "15:00", ask: null, place: null, memo: null });
  assert.deepEqual(pick("8시 운동").ask, ["08:00", "20:00"]);
  assert.equal(pick("8시 운동").day, null);
  assert.equal(pick("저녁 8시 반 약속").time, "20:30");
  assert.equal(pick("다음 주 월요일 서류 제출").day, "2026-11-30"); // 한 주는 일요일 시작
  assert.equal(pick("다음 주 월요일 서류 제출").title, "서류 제출");
  assert.deepEqual(pick("우유 사기"), { title: "우유 사기", day: null, time: null, ask: null, place: null, memo: null });
});

test("장소와 메모", () => {
  assert.deepEqual(pick("내일 오후 3시 치과 @강남역 // 보험증 챙기기"), {
    title: "치과", day: "2026-11-23", time: "15:00", ask: null, place: "강남역", memo: "보험증 챙기기",
  });
  assert.equal(pick("메일 me@example.com 보내기").place, null); // 글자 사이 @는 장소가 아님
  assert.equal(pick("자료 http://a.com 보기").memo, null); // 주소의 //는 메모가 아님
  assert.equal(pick("강남역 치과").place, null);
});

test("시각 규칙", () => {
  assert.equal(pick("0시 정리").time, "00:00");
  assert.equal(pick("13시 점심").time, "13:00");
  assert.equal(pick("15:00 회의").time, "15:00");
  assert.equal(pick("03:30 알람").time, "03:30");
  assert.deepEqual(pick("3:30 전화").ask, ["03:30", "15:30"]);
  assert.equal(pick("오전 12시 정리").time, "00:00");
  assert.equal(pick("밤 12시 정리").time, "00:00");
  assert.equal(pick("낮 2시 산책").time, "14:00");
  assert.equal(pick("정오 점심").time, "12:00");
  assert.equal(pick("25시 이상한 일").time, null); // 없는 시각은 글자 그대로
  assert.equal(pick("25시 이상한 일").title, "25시 이상한 일");
});

test("날짜 규칙", () => {
  assert.equal(pick("11/30 마감").day, "2026-11-30");
  assert.equal(pick("12월 3일 여행").day, "2026-12-03");
  assert.equal(pick("2026-02-30 없는 날").day, null);
  assert.equal(pick("25일 월급").day, "2026-11-25");
  assert.equal(pick("20일 지난 날").day, "2026-12-20"); // 지났으면 다음 달
  assert.equal(pick("일요일 청소").day, "2026-11-22"); // 오늘이 그 요일이면 오늘
  assert.equal(pick("이번 주 토요일 대청소").day, "2026-11-28");
  assert.equal(pick("월요일에 보고").title, "보고");
  assert.equal(pick("내일").title, "내일"); // 이름이 남지 않으면 떼지 않는다
  assert.equal(pick("내일").day, null);
  assert.equal(pick("일정 정리").day, null); // 낱말 안의 '일'은 건드리지 않음
});

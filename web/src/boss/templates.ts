// 위장 화면 업무 시트 템플릿(SCR-12). 사람 이름·숫자는 모두 지어낸 예시이고, 날짜는 오늘 기준으로 맞춘다.

export interface CellStyle {
  b?: boolean;
  bg?: string;
  fg?: string;
  right?: boolean;
  size?: number;
  /** 위에 굵은 선(합계 행) */
  top?: boolean;
  /** 보여 주는 형식: pct 백분율, num 숫자 */
  fmt?: "pct" | "num";
}

export interface SheetData {
  name: string;
  /** 열 너비(px), 모자라면 기본 80 */
  widths: number[];
  /** 주소 → 입력값('='이면 수식) */
  cells: Record<string, string>;
  styles: Record<string, CellStyle>;
  /** 처음 열었을 때 선택된 셀(작업 흔적) */
  cursor?: string;
}

export interface Workbook {
  /** 제목 줄·탭 제목에 쓰는 파일 이름 */
  fileName: string;
  sheets: SheetData[];
}

export type TemplateId = "weekly" | "sales" | "schedule" | "budget";

export const TEMPLATE_NAMES: { id: TemplateId | "myfile"; name: string }[] = [
  { id: "weekly", name: "주간 업무 보고" },
  { id: "sales", name: "매출 요약" },
  { id: "schedule", name: "프로젝트 일정표" },
  { id: "budget", name: "예산 집행 현황" },
  { id: "myfile", name: "내 파일" },
];

const HEAD: CellStyle = { b: true, bg: "#E8F3EC" };
const TITLE: CellStyle = { b: true, size: 15 };
const MUTED: CellStyle = { fg: "#4B5563" };
const STATUS: Record<string, CellStyle> = {
  완료: { bg: "#E3F4EA", fg: "#1F5E3A" },
  "진행 중": { bg: "#FFF6CC", fg: "#6B4E00" },
  대기: { bg: "#F1F2F4", fg: "#454A52" },
  지연: { bg: "#FDE8E6", fg: "#9B2C1F" },
};

const PEOPLE = ["김지윤", "박민호", "이서연", "최도현", "정하늘", "윤재원"];

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function monday(today: Date): Date {
  const day = (today.getDay() + 6) % 7;
  const result = addDays(today, -day);
  result.setHours(0, 0, 0, 0);
  return result;
}

const md = (date: Date) => `${date.getMonth() + 1}/${date.getDate()}`;
const ymd = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

class Builder {
  cells: Record<string, string> = {};
  styles: Record<string, CellStyle> = {};

  row(rowNumber: number, values: (string | number | null)[], style?: CellStyle, startCol = 0): void {
    values.forEach((value, index) => {
      const key = `${String.fromCharCode(65 + startCol + index)}${rowNumber}`;
      if (value !== null && value !== "") this.cells[key] = String(value);
      if (style) this.styles[key] = { ...this.styles[key], ...style };
    });
  }

  style(key: string, style: CellStyle): void {
    this.styles[key] = { ...this.styles[key], ...style };
  }

  sheet(name: string, widths: number[], cursor?: string): SheetData {
    return { name, widths, cells: this.cells, styles: this.styles, cursor };
  }
}

function weekly(today: Date): Workbook {
  const start = monday(today);
  const end = addDays(start, 4);
  const week = Math.floor((start.getDate() - 1) / 7) + 1;
  const month = start.getMonth() + 1;
  const d = (offset: number) => md(addDays(start, offset));
  const main = new Builder();
  main.row(1, [`주간 업무 보고 (${month}월 ${week}주차, ${md(start)} ~ ${md(end)})`], TITLE);
  main.row(2, [`작성: 운영지원팀, 기준일 ${ymd(today)}`], MUTED);
  main.row(3, ["구분", "업무 내용", "담당", "시작", "진행률", "완료 예정", "상태", "비고"], HEAD);
  const tasks: [string, string, number, string, string, string, string][] = [
    ["기획", "4분기 고객 만족도 조사 결과 정리", 0, d(0), "80%", d(4), "진행 중"],
    ["기획", "다음 분기 프로모션 일정안", 1, d(1), "40%", d(11), "진행 중"],
    ["운영", "주간 매출 리포트 작성", 2, d(0), "100%", d(1), "완료"],
    ["운영", "재고 현황 점검 (물류센터 B)", 3, d(2), "60%", d(7), "진행 중"],
    ["운영", "협력사 계약 갱신 서류 검토", 0, d(3), "20%", d(10), "대기"],
    ["개발", "사내 포털 공지 게시판 개선", 1, d(-7), "75%", d(4), "진행 중"],
    ["개발", "로그인 오류 문의 대응", 2, d(1), "100%", d(2), "완료"],
    ["지원", "신규 입사자 계정 발급 (3명)", 3, d(0), "100%", d(0), "완료"],
    ["지원", "워크숍 장소 견적 비교", 0, d(2), "50%", d(9), "진행 중"],
    ["지원", "연말 정산 안내문 초안", 1, d(3), "10%", d(14), "대기"],
  ];
  const notes = ["", "팀장 검토", "", "", "법무 회신", "", "", "", "3곳", ""];
  tasks.forEach((task, index) => {
    const r = index + 4;
    main.row(r, [task[0], task[1], PEOPLE[task[2]] ?? "", task[3], task[4], task[5], task[6], notes[index] ?? ""]);
    main.style(`D${r}`, { right: true });
    main.style(`E${r}`, { right: true });
    main.style(`F${r}`, { right: true });
    main.style(`G${r}`, STATUS[task[6]] ?? {});
    main.style(`H${r}`, MUTED);
  });
  main.row(14, ["", "평균 진행률 / 완료 건수", "", "", "=AVERAGE(E4:E13)", "", '="완료 "&COUNTIF(G4:G13,"완료")&"건"', ""], { top: true });
  main.style("B14", { b: true });
  main.style("E14", { b: true, right: true, fmt: "pct" });
  main.style("G14", { b: true });

  const plan = new Builder();
  plan.row(1, [`주간 일정 (${md(start)} ~ ${md(end)})`], TITLE);
  plan.row(3, ["날짜", "시간", "일정", "장소", "참석"], HEAD);
  const days = ["월", "화", "수", "목", "금"];
  const items = [
    ["10:00", "주간 업무 회의", "3층 회의실", "팀 전체"],
    ["14:00", "협력사 미팅", "화상", "김지윤, 박민호"],
    ["11:00", "포털 개선 중간 점검", "2층 소회의실", "박민호, 이서연"],
    ["15:30", "재고 실사 결과 공유", "물류센터 B", "최도현"],
    ["16:00", "주간 마감 및 보고서 제출", "-", "팀 전체"],
  ];
  items.forEach((item, index) => {
    plan.row(index + 4, [`${d(index)}(${days[index]})`, ...item]);
  });

  const issues = new Builder();
  issues.row(1, ["이슈 관리"], TITLE);
  issues.row(3, ["번호", "내용", "등록일", "담당", "상태"], HEAD);
  [
    ["물류센터 B 재고 수량 차이(12건)", d(2), PEOPLE[3] ?? "", "진행 중"],
    ["포털 공지 첨부파일 미리보기 오류", d(-3), PEOPLE[1] ?? "", "진행 중"],
    ["협력사 계약서 서명본 회신 지연", d(3), PEOPLE[0] ?? "", "대기"],
  ].forEach((item, index) => {
    issues.row(index + 4, [index + 1, ...item]);
    issues.style(`E${index + 4}`, STATUS[item[3] ?? ""] ?? {});
  });

  return {
    fileName: `주간업무보고_${month}월${week}주차.xlsx`,
    sheets: [
      main.sheet("주간보고", [56, 260, 70, 64, 64, 72, 76, 90], "E14"),
      plan.sheet("일정", [90, 60, 200, 110, 140]),
      issues.sheet("이슈", [50, 280, 70, 70, 76]),
    ],
  };
}

function sales(today: Date): Workbook {
  const year = today.getFullYear();
  const month = today.getMonth() + 1;
  const main = new Builder();
  main.row(1, [`${year}년 ${month}월 매출 요약 (단위: 천 원)`], TITLE);
  main.row(2, [`기준일 ${ymd(today)}, 영업관리팀`], MUTED);
  main.row(3, ["지점", "목표", "실적", "달성률", "전월 실적", "증감률", "비고"], HEAD);
  const rows: [string, number, number, number, string][] = [
    ["서울 본점", 182000, 175420, 168300, ""],
    ["강남점", 154000, 161280, 149900, "프로모션 효과"],
    ["판교점", 98000, 87650, 91200, ""],
    ["부산점", 112000, 108930, 104410, ""],
    ["대구점", 76000, 79120, 72880, ""],
    ["온라인", 210000, 226840, 198760, "주말 행사"],
    ["기업 고객", 135000, 118200, 129500, "1건 이월"],
  ];
  rows.forEach((item, index) => {
    const r = index + 4;
    main.row(r, [item[0], item[1].toLocaleString("ko-KR"), item[2].toLocaleString("ko-KR"), `=C${r}/B${r}`, item[3].toLocaleString("ko-KR"), `=(C${r}-E${r})/E${r}`, item[4]]);
    for (const col of "BCE") main.style(`${col}${r}`, { right: true });
    main.style(`D${r}`, { right: true, fmt: "pct" });
    main.style(`F${r}`, { right: true, fmt: "pct" });
    main.style(`G${r}`, MUTED);
  });
  main.row(11, ["합계", "=SUM(B4:B10)", "=SUM(C4:C10)", "=C11/B11", "=SUM(E4:E10)", "=(C11-E11)/E11", ""], { top: true, b: true });
  for (const col of "BCE") main.style(`${col}11`, { right: true });
  main.style("D11", { right: true, fmt: "pct" });
  main.style("F11", { right: true, fmt: "pct" });

  const byMonth = new Builder();
  byMonth.row(1, [`${year}년 월별 매출 (단위: 천 원)`], TITLE);
  byMonth.row(3, ["월", "매출", "목표", "달성률"], HEAD);
  let r = 4;
  for (let m = 1; m <= month; m += 1) {
    const base = 880000 + ((m * 37) % 11) * 21000;
    byMonth.row(r, [`${m}월`, (base + m * 9000).toLocaleString("ko-KR"), (950000 + m * 5000).toLocaleString("ko-KR"), `=B${r}/C${r}`]);
    byMonth.style(`B${r}`, { right: true });
    byMonth.style(`C${r}`, { right: true });
    byMonth.style(`D${r}`, { right: true, fmt: "pct" });
    r += 1;
  }
  byMonth.row(r, ["누계", `=SUM(B4:B${r - 1})`, `=SUM(C4:C${r - 1})`, `=B${r}/C${r}`], { top: true, b: true });
  byMonth.style(`B${r}`, { right: true });
  byMonth.style(`C${r}`, { right: true });
  byMonth.style(`D${r}`, { right: true, fmt: "pct" });

  return {
    fileName: `매출요약_${year}년${month}월.xlsx`,
    sheets: [main.sheet("매출 요약", [110, 90, 90, 72, 90, 72, 120], "C9"), byMonth.sheet("월별", [60, 100, 100, 72])],
  };
}

function schedule(today: Date): Workbook {
  const start = addDays(monday(today), -21);
  const main = new Builder();
  main.row(1, ["사내 포털 개편 프로젝트 일정표"], TITLE);
  main.row(2, [`PM ${PEOPLE[1]}, 갱신 ${ymd(today)}`], MUTED);
  main.row(3, ["단계", "작업", "담당", "시작", "종료", "기간(일)", "진행률", "상태"], HEAD);
  const steps: [string, string, number, number, number, string][] = [
    ["분석", "현행 화면 및 사용 현황 조사", 2, 0, 6, "100%"],
    ["분석", "요구사항 정리 및 우선순위", 1, 4, 11, "100%"],
    ["설계", "화면 설계(메인, 게시판)", 4, 11, 20, "90%"],
    ["설계", "데이터 이관 계획", 3, 14, 22, "70%"],
    ["개발", "게시판 개선", 1, 18, 32, "55%"],
    ["개발", "검색 기능 개선", 5, 21, 35, "35%"],
    ["개발", "권한 및 로그인 연동", 2, 23, 37, "20%"],
    ["시험", "통합 시험", 3, 35, 42, "0%"],
    ["시험", "사용자 시험 및 교육", 0, 40, 46, "0%"],
    ["오픈", "운영 전환", 1, 47, 49, "0%"],
  ];
  steps.forEach((step, index) => {
    const r = index + 4;
    const pct = Number(step[5].replace("%", ""));
    const ends = addDays(start, step[4]);
    const status = pct === 100 ? "완료" : pct === 0 ? "대기" : ends < today ? "지연" : "진행 중";
    main.row(r, [step[0], step[1], PEOPLE[step[2]] ?? "", ymd(addDays(start, step[3])), ymd(ends), step[4] - step[3] + 1, step[5], status]);
    for (const col of "DEFG") main.style(`${col}${r}`, { right: true });
    main.style(`H${r}`, STATUS[status] ?? {});
  });
  main.row(14, ["", "전체 진행률", "", "", "", "=SUM(F4:F13)", "=AVERAGE(G4:G13)", '=COUNTIF(H4:H13,"완료")&"/"&COUNTA(H4:H13)&" 완료"'], { top: true, b: true });
  main.style("F14", { right: true });
  main.style("G14", { right: true, fmt: "pct" });
  return {
    fileName: "포털개편_일정표.xlsx",
    sheets: [main.sheet("일정표", [56, 220, 70, 92, 92, 70, 64, 90], "G8")],
  };
}

function budget(today: Date): Workbook {
  const year = today.getFullYear();
  const quarter = Math.floor(today.getMonth() / 3) + 1;
  const main = new Builder();
  main.row(1, [`${year}년 ${quarter}분기 예산 집행 현황 (단위: 원)`], TITLE);
  main.row(2, [`경영지원팀, ${ymd(today)} 기준`], MUTED);
  main.row(3, ["항목", "예산", "집행액", "잔액", "집행률", "비고"], HEAD);
  const items: [string, number, number, string][] = [
    ["인건비(외주)", 48000000, 39600000, ""],
    ["교육/세미나", 6500000, 4120000, "온라인 강의 2건"],
    ["회의/접대비", 3200000, 2875000, ""],
    ["소모품", 1800000, 1236400, ""],
    ["소프트웨어 구독", 9600000, 9600000, "연간 결제"],
    ["출장/교통비", 4500000, 2318700, ""],
    ["행사비", 7000000, 1450000, "워크숍 예정"],
    ["예비비", 3000000, 0, ""],
  ];
  items.forEach((item, index) => {
    const r = index + 4;
    main.row(r, [item[0], item[1].toLocaleString("ko-KR"), item[2].toLocaleString("ko-KR"), `=B${r}-C${r}`, `=C${r}/B${r}`, item[3]]);
    for (const col of "BCD") main.style(`${col}${r}`, { right: true });
    main.style(`E${r}`, { right: true, fmt: "pct" });
    main.style(`F${r}`, MUTED);
  });
  main.row(12, ["합계", "=SUM(B4:B11)", "=SUM(C4:C11)", "=SUM(D4:D11)", "=C12/B12", ""], { top: true, b: true });
  for (const col of "BCD") main.style(`${col}12`, { right: true });
  main.style("E12", { right: true, fmt: "pct" });
  return {
    fileName: `예산집행현황_${year}년${quarter}분기.xlsx`,
    sheets: [main.sheet(`${quarter}분기`, [130, 110, 110, 110, 72, 140], "C9"), { name: "Sheet2", widths: [], cells: {}, styles: {} }],
  };
}

export function buildTemplate(id: TemplateId, today = new Date()): Workbook {
  if (id === "sales") return sales(today);
  if (id === "schedule") return schedule(today);
  if (id === "budget") return budget(today);
  return weekly(today);
}

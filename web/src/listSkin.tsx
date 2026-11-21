// 왼쪽 목록(서버, 채널)을 테마 컨셉에 맞춘 모양으로: 아이콘, 이름 뒤 확장자, '읽기 전용' 표현, 머리 글자
// 기본과 다크는 메모 앱 폴더, 스프레드시트는 통합 문서와 시트, 메모장은 파일 열기 창, 노션은 사이드바 트리, Word는 문서 열기
import type { ReactNode } from "react";
import type { Theme } from "./theme";
import type { ChannelInfo, Group } from "./types";

function Svg({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg className="skin-icon" width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      {children}
    </svg>
  );
}

const folder = (fill: string) => (
  <Svg size={20}>
    <path d="M2.5 5.5a1 1 0 0 1 1-1h4l1.5 1.5h7.5a1 1 0 0 1 1 1V15a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z" fill={fill} />
  </Svg>
);

const memoNote = (
  <Svg>
    <rect x="4" y="2.5" width="12" height="15" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path d="M7 7h6M7 10h6M7 13h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </Svg>
);

const memoStack = (
  <Svg>
    <rect x="5" y="5" width="11" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path
      d="M4 13V4.5A1.5 1.5 0 0 1 5.5 3H13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </Svg>
);

/** 비공개 채널(모든 테마) */
export const lockIcon = (
  <Svg size={13}>
    <rect x="5" y="9" width="10" height="8" rx="1.5" fill="currentColor" />
    <path d="M7 9V7a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" strokeWidth="1.6" />
  </Svg>
);

/** 글을 쓸 수 없음(기본, 다크): 보기만 하는 눈 */
const noWrite = (
  <Svg size={15}>
    <path d="M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5z" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <circle cx="10" cy="10" r="2.2" fill="currentColor" />
  </Svg>
);

const workbook = (
  <Svg size={20}>
    <rect x="3" y="3" width="14" height="14" rx="2" fill="#1f6e43" />
    <path d="M6 7h8M6 10h8M6 13h8M9 5v10" stroke="#ffffff" strokeWidth="1.2" />
  </Svg>
);

const sheetGrid = (
  <Svg>
    <rect x="3.5" y="4.5" width="13" height="11" fill="none" stroke="#1f6e43" strokeWidth="1.3" />
    <path d="M3.5 8h13M3.5 11.5h13M8 4.5v11" stroke="#1f6e43" strokeWidth="1.1" />
  </Svg>
);

const textFile = (
  <Svg>
    <path d="M5 2.5h7l3.5 3.5v11.5H5z" fill="#ffffff" stroke="#777777" strokeWidth="1" />
    <path d="M7 9h6M7 11.5h6M7 14h4" stroke="#999999" strokeWidth="1" />
  </Svg>
);

const yellowFolder = (
  <Svg>
    <path d="M2.5 5.5h5l1.5 1.5h8.5v9h-15z" fill="#f2c94c" stroke="#c9a227" strokeWidth="0.8" />
  </Svg>
);

const wordDoc = (
  <Svg size={20}>
    <path d="M5 2.5h7l3.5 3.5v11.5H5z" fill="#ffffff" stroke="#185abd" strokeWidth="1.2" />
    <path d="M7 9h6M7 11.5h6M7 14h4" stroke="#185abd" strokeWidth="1.1" />
  </Svg>
);

// 노션 팀스페이스: 서버마다 같은 색 네모
const SQUARES = ["🟦", "🟩", "🟪", "🟧", "🟥", "🟨", "🟫"];

function squareFor(id: string): string {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return SQUARES[hash % SQUARES.length] ?? "🟦";
}

export interface ListSkin {
  /** 서버 목록 머리 글자 */
  groupsTitle: string;
  /** 고정한 채널 묶음 이름, 전체 서버 묶음 이름(null이면 이름 줄 없음) */
  pinnedTitle: string;
  allTitle: string | null;
  serverIcon: (group: Group) => ReactNode;
  /** 서버 이름 뒤 흐린 확장자 */
  serverExt: string;
  channelIcon: (channel: ChannelInfo) => ReactNode;
  channelExt: (channel: ChannelInfo) => string;
  readOnly: ReactNode;
  /** 채널 목록 머리 글자(서버 이름) */
  channelsTitle: (name: string) => string;
  /** 안 읽은 수: 숫자, 괄호 숫자, 점 */
  badge: "count" | "paren" | "dot";
  /** 왼쪽 아래 서버 인원 묶음 이름 */
  membersTitle: string;
}

const plain = (channel: ChannelInfo) => (channel.kind === "forum" ? memoStack : memoNote);

export function listSkin(theme: Theme): ListSkin {
  switch (theme) {
    case "sheet":
      return {
        groupsTitle: "열기",
        pinnedTitle: "고정",
        allTitle: "최근 통합 문서",
        serverIcon: () => workbook,
        serverExt: ".xlsx",
        channelIcon: () => sheetGrid,
        channelExt: () => "",
        readOnly: <span className="skin-ro">읽기 전용</span>,
        channelsTitle: (name) => `${name}.xlsx`,
        badge: "paren",
        membersTitle: "공유 대상",
      };
    case "memo":
      return {
        groupsTitle: "열기",
        pinnedTitle: "즐겨찾기",
        allTitle: null,
        serverIcon: () => yellowFolder,
        serverExt: "",
        channelIcon: (channel) => (channel.kind === "forum" ? yellowFolder : textFile),
        channelExt: (channel) => (channel.kind === "forum" ? "" : ".txt"),
        readOnly: <span className="skin-ro">[읽기 전용]</span>,
        channelsTitle: () => "열기",
        badge: "paren",
        membersTitle: "공유 대상",
      };
    case "note":
      return {
        groupsTitle: "워크스페이스",
        pinnedTitle: "즐겨찾기",
        allTitle: "팀스페이스",
        serverIcon: (group) => <span className="skin-emoji">{squareFor(group.id)}</span>,
        serverExt: "",
        channelIcon: (channel) => <span className="skin-emoji">{channel.kind === "forum" ? "🗂️" : "📄"}</span>,
        channelExt: () => "",
        readOnly: <span className="skin-ro">보기 전용</span>,
        channelsTitle: (name) => name,
        badge: "count",
        membersTitle: "멤버",
      };
    case "word":
      return {
        groupsTitle: "열기",
        pinnedTitle: "고정",
        allTitle: null,
        serverIcon: () => folder("#8ab4f8"),
        serverExt: "",
        channelIcon: (channel) => (channel.kind === "forum" ? folder("#8ab4f8") : wordDoc),
        channelExt: (channel) => (channel.kind === "forum" ? "" : ".docx"),
        readOnly: <span className="skin-ro">읽기 전용</span>,
        channelsTitle: (name) => name,
        badge: "dot",
        membersTitle: "공유 대상",
      };
    default:
      // 기본, 다크: 메모 앱 폴더
      return {
        groupsTitle: "폴더",
        pinnedTitle: "고정",
        allTitle: "전체",
        serverIcon: () => folder("var(--honey)"),
        serverExt: "",
        channelIcon: plain,
        channelExt: () => "",
        readOnly: (
          <span className="skin-ro skin-lock" role="img" aria-label="읽기 전용" title="읽기 전용">
            {noWrite}
          </span>
        ),
        channelsTitle: (name) => name,
        badge: "count",
        membersTitle: "함께 보는 사람",
      };
  }
}

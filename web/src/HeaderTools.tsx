// 채팅방 머리 오른쪽의 진짜 단추: 스레드, 서랍(테마마다 서랍, 찾기, 검색, 탐색).
// 위장 화면이어도 누를 수 있는 단추로 보이게 아이콘, 테두리, 마우스 올림 색을 준다.
// 순서는 스레드 다음에 서랍(서랍이 화면 오른쪽 끝에서 열리므로 가까이).
import { drawerTitle } from "./Drawer";

function ThreadIcon() {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M3.5 4.5h9a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H8l-3 2.5v-2.5H3.5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z" strokeLinejoin="round" />
      <path d="M15.5 8h1a1 1 0 0 1 1 1v4.5a1 1 0 0 1-1 1h-1v2l-2.5-2h-3" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7">
      <circle cx="8.5" cy="8.5" r="5" />
      <path d="m12.5 12.5 4.5 4.5" strokeLinecap="round" />
    </svg>
  );
}

function DrawerIcon() {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="3" y="3.5" width="14" height="13" rx="2" />
      <path d="M3 10.5h4l1 2h4l1-2h4" strokeLinejoin="round" />
    </svg>
  );
}

export default function HeaderTools({
  theme,
  drawerOpen,
  onDrawer,
  onThreads,
  className = "header-tools",
}: {
  theme: string;
  drawerOpen: boolean;
  onDrawer?: () => void;
  /** 일반 채널이면 스레드 목록 열기(스레드 안에서는 없음) */
  onThreads?: () => void;
  className?: string;
}) {
  const title = drawerTitle(theme);
  return (
    <div className={className}>
      {onThreads && (
        <button type="button" className="header-tool" aria-label="스레드 목록" onClick={onThreads}>
          <ThreadIcon />
          <span className="header-tool-label">스레드</span>
        </button>
      )}
      {onDrawer && (
        <button
          type="button"
          className={drawerOpen ? "header-tool header-tool-on" : "header-tool"}
          aria-label={`${title}(메시지 찾기, 고정, 사진, 파일, 멤버)`}
          aria-expanded={drawerOpen}
          onClick={onDrawer}
        >
          {title === "서랍" ? <DrawerIcon /> : <SearchIcon />}
          <span className="header-tool-label">{title}</span>
        </button>
      )}
    </div>
  );
}

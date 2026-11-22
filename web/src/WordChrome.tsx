// Word 테마의 맨 위: 파란 제목 줄(문서 이름, 저장됨, 검색), 리본 탭, 서식 도구 줄.
// 문서 이름(탭 제목)만 눌러서 고칠 수 있고, 나머지는 아무 일도 하지 않는 장식이라 화면 읽기 프로그램에는 숨긴다.
import EditableText from "./EditableText";
import { useLook } from "./lookContext";
import { defaultTitle } from "./theme";

function Icon({ path, size = 16 }: { path: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={path} />
    </svg>
  );
}

const TABS = ["파일", "홈", "삽입", "레이아웃", "참조", "검토", "보기", "도움말"];

/** name을 주면(위장 화면) 그 이름을 그대로 보여 주고, 없으면 탭 제목을 눌러서 고칠 수 있게 */
export default function WordChrome({
  name,
  onTodo,
}: {
  name?: string;
  /** 위장 화면에서만: 리본 끝 'TODO' 탭 */ onTodo?: () => void;
}) {
  const { settings, save } = useLook();
  const fallback = defaultTitle("word");
  return (
    <div className="word-chrome">
      <div className="word-bar">
        <span className="word-waffle" aria-hidden="true">
          {Array.from({ length: 9 }, (_, index) => (
            <i key={index} />
          ))}
        </span>
        <span className="word-app-name" aria-hidden="true">
          Word
        </span>
        {name ? (
          <span className="word-doc-name">{name}</span>
        ) : (
          <EditableText
            className="word-doc-name"
            value={settings.tab_title || fallback}
            fallback={fallback}
            maxLength={40}
            label="문서 이름(탭 제목)"
            onSave={(text) => void save({ tab_title: text })}
          />
        )}
        <span className="word-saved" aria-hidden="true">
          저장됨
        </span>
        <span className="word-search" aria-hidden="true">
          <Icon path="M9 4a5 5 0 1 0 0 10A5 5 0 0 0 9 4zm4 9 4 4" />
          검색(Alt + Q)
        </span>
      </div>
      <div className="word-ribbon">
        {TABS.map((tab) => (
          <span key={tab} className={tab === "홈" ? "word-tab word-tab-on" : "word-tab"} aria-hidden="true">
            {tab}
          </span>
        ))}
        {onTodo && (
          <button type="button" tabIndex={-1} className="word-tab word-tab-todo" onClick={onTodo}>
            TODO
          </button>
        )}
        <span className="word-ribbon-right" aria-hidden="true">
          <span className="word-chip">
            <Icon path="M4 16l1-4 8-8 3 3-8 8z" size={14} />
            편집 중
          </span>
          <span className="word-chip">
            <Icon path="M3.5 4.5h13v9h-7l-3.5 3v-3h-2.5z" size={14} />
            메모
          </span>
          <span className="word-chip word-chip-blue">
            <Icon path="M10 3v10M6 7l4-4 4 4M4 12v4.5h12V12" size={14} />
            공유
          </span>
        </span>
      </div>
      <div className="word-tools" aria-hidden="true">
        <Icon path="M7 5 3.5 8.5 7 12M3.5 8.5H12a4 4 0 0 1 0 8h-2" />
        <span className="word-sep" />
        <span className="word-box">맑은 고딕</span>
        <span className="word-box">11</span>
        <b>B</b>
        <i>I</i>
        <u>U</u>
        <span className="word-sep" />
        <Icon path="M8 5h9M8 10h9M8 15h9M3.5 5h1M3.5 10h1M3.5 15h1" />
        <Icon path="M3 5h14M3 9h9M3 13h14M3 17h9" />
        <span className="word-box">표준</span>
        <span className="word-box word-box-dim">제목 1</span>
      </div>
    </div>
  );
}

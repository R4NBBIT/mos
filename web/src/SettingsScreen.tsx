import { type ReactNode, useEffect, useState } from "react";
import { updateSettings } from "./api";
import { defaultTitle, type Settings, THEMES, type Theme } from "./theme";

// 테마 고르기 카드의 작은 미리보기(화면명세서 SCR-10)
function Preview({ theme }: { theme: Theme }) {
  if (theme === "sheet") {
    return (
      <div className="theme-preview theme-preview-sheet" aria-hidden="true">
        {Array.from({ length: 16 }, (_, index) => (
          <span key={index} className={index < 4 || index % 4 === 0 ? "h" : index === 9 || index === 10 ? "m" : ""} />
        ))}
      </div>
    );
  }
  if (theme === "memo") {
    return (
      <div className="theme-preview theme-preview-memo" aria-hidden="true">
        <span style={{ width: "85%" }} />
        <span style={{ width: "70%" }} />
        <span style={{ width: "80%" }} />
        <span style={{ width: "55%" }} />
      </div>
    );
  }
  return (
    <div className={`theme-preview theme-preview-${theme}`} aria-hidden="true">
      <span className="o" />
      <span className="m" />
      <span className="o" style={{ width: "50%" }} />
    </div>
  );
}

interface Props {
  settings: Settings;
  onChange: (settings: Settings) => void;
  onBack: () => void;
  menu: ReactNode;
}

export default function SettingsScreen({ settings, onChange, onBack, menu }: Props) {
  const [title, setTitle] = useState(settings.tab_title ?? "");
  const [error, setError] = useState("");

  useEffect(() => setTitle(settings.tab_title ?? ""), [settings.tab_title]);

  const save = async (changes: Partial<Settings>) => {
    setError("");
    try {
      onChange(await updateSettings(changes));
    } catch {
      setError("저장하지 못했어요. 잠시 후 다시 해 주세요.");
    }
  };

  return (
    <div className="room">
      <header className="room-header">
        <button type="button" className="back-button" onClick={onBack} aria-label="뒤로">
          ‹
        </button>
        <div className="room-title">
          <strong>설정</strong>
        </div>
        {menu}
      </header>
      <div className="list-body settings">
        {error && <p className="list-error">{error}</p>}
        <h2 className="list-section-title">테마</h2>
        <div className="theme-grid">
          {THEMES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.id === settings.theme ? "theme-card theme-card-on" : "theme-card"}
              aria-pressed={item.id === settings.theme}
              onClick={() => void save({ theme: item.id })}
            >
              <Preview theme={item.id} />
              <span>
                {item.name}
                {item.id === settings.theme ? " · 사용 중" : ""}
              </span>
            </button>
          ))}
        </div>
        <p className="settings-note">고르는 즉시 바뀌고, 이 계정에 기억돼요. 탭 제목과 아이콘도 테마에 맞춰 바뀌어요.</p>

        <h2 className="list-section-title">위장</h2>
        <form
          className="settings-row"
          onSubmit={(event) => {
            event.preventDefault();
            void save({ tab_title: title.trim() || null });
          }}
        >
          <label htmlFor="tab-title">탭 제목</label>
          <input
            id="tab-title"
            value={title}
            maxLength={40}
            placeholder={defaultTitle(settings.theme)}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => {
              if ((title.trim() || null) !== settings.tab_title) void save({ tab_title: title.trim() || null });
            }}
          />
        </form>
        <p className="settings-note">비워 두면 테마 기본값({defaultTitle(settings.theme)})을 써요.</p>
      </div>
    </div>
  );
}

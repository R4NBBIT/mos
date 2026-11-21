import { type ChangeEvent, type ReactNode, useEffect, useState } from "react";
import { updateSettings } from "./api";
import BossKeyPicker from "./BossKeyPicker";
import { bossKeyLabel, parseBossKey } from "./boss/bossKey";
import { clearMyFile, FileImportError, importMyFile, loadMyFile } from "./boss/myFile";
import { TEMPLATE_NAMES } from "./boss/templates";
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
  /** 위장 화면 미리 보기 */
  onShowBoss: () => void;
  /** 내 파일을 불러오거나 지웠을 때 */
  onFileChanged: () => void;
}

export default function SettingsScreen({ settings, onChange, onBack, menu, onShowBoss, onFileChanged }: Props) {
  const [title, setTitle] = useState(settings.tab_title ?? "");
  const [error, setError] = useState("");
  const [myFile, setMyFile] = useState(() => loadMyFile()?.fileName ?? null);
  const [fileBusy, setFileBusy] = useState(false);
  const [fileError, setFileError] = useState("");

  const pickFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setFileBusy(true);
    setFileError("");
    try {
      const stored = await importMyFile(file);
      setMyFile(stored.fileName);
      onFileChanged();
      if (settings.boss_template !== "myfile") void save({ boss_template: "myfile" });
    } catch (caught) {
      setFileError(caught instanceof FileImportError ? caught.message : "파일을 읽지 못했어요.");
    } finally {
      setFileBusy(false);
    }
  };

  useEffect(() => setTitle(settings.tab_title ?? ""), [settings.tab_title]);

  const save = async (changes: Partial<Settings>) => {
    setError("");
    const before = settings;
    onChange({ ...settings, ...changes }); // 바로 보이게, 실패하면 되돌림
    try {
      onChange(await updateSettings(changes));
    } catch {
      onChange(before);
      setError("저장하지 못했어요. 잠시 후 다시 해 주세요.");
    }
  };

  return (
    <div className="room room-page">
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
        <section className="settings-card">
          <h2 className="settings-title">테마</h2>
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
        </section>

        <section className="settings-card">
          <h2 className="settings-title">탭 제목</h2>
          <form
            className="settings-row"
            onSubmit={(event) => {
              event.preventDefault();
              void save({ tab_title: title.trim() || null });
            }}
          >
            <input
              id="tab-title"
              aria-label="탭 제목"
              value={title}
              maxLength={40}
              placeholder={defaultTitle(settings.theme)}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => {
                if ((title.trim() || null) !== settings.tab_title) void save({ tab_title: title.trim() || null });
              }}
            />
          </form>
          <p className="settings-note">비워 두면 테마 기본값({defaultTitle(settings.theme)})을 써요. 잠금 화면 제목도 같이 바뀌어요.</p>
        </section>

        <section className="settings-card">
          <h2 className="settings-title">위장 화면</h2>
          <p className="settings-note settings-lead">
            어느 화면에서든 보스키({bossKeyLabel(parseBossKey(settings.boss_key))})를 누르면 업무 표로 바뀌고, 한 번 더
            누르면 돌아와요. 화면 왼쪽 아래 모서리를 눌러도 돼요.
          </p>
          <BossKeyPicker value={settings.boss_key} onSave={(value) => void save({ boss_key: value })} />

          <h3 className="settings-sub">보여 줄 표</h3>
          <div className="boss-choices" role="radiogroup" aria-label="위장 화면 표">
            {TEMPLATE_NAMES.map((item) => {
              const disabled = item.id === "myfile" && !myFile;
              return (
                <label key={item.id} className={disabled ? "boss-choice boss-choice-off" : "boss-choice"}>
                  <input
                    type="radio"
                    name="boss-template"
                    checked={settings.boss_template === item.id}
                    disabled={disabled}
                    onChange={() => void save({ boss_template: item.id })}
                  />
                  {item.id === "myfile" ? `내 파일${myFile ? `: ${myFile}` : "(아직 없음)"}` : item.name}
                </label>
              );
            })}
          </div>
          <div className="settings-buttons">
            <label className={fileBusy ? "pill-button busy" : "pill-button"}>
              {fileBusy ? "읽는 중…" : "내 파일 불러오기(.xlsx, .csv)"}
              <input type="file" accept=".xlsx,.xlsm,.csv" hidden disabled={fileBusy} onChange={(event) => void pickFile(event)} />
            </label>
            {myFile && (
              <button
                type="button"
                className="pill-button"
                onClick={() => {
                  clearMyFile();
                  setMyFile(null);
                  onFileChanged();
                  if (settings.boss_template === "myfile") void save({ boss_template: "weekly" });
                }}
              >
                내 파일 지우기
              </button>
            )}
            <button type="button" className="pill-button pill-button-strong" onClick={onShowBoss}>
              지금 보기
            </button>
          </div>
          {fileError && <p className="list-error">{fileError}</p>}
          <p className="settings-note">
            불러온 파일과 표에 고친 내용은 이 브라우저에만 남고 서버로 보내지 않아요. 수식은 파일에 저장된 값으로 보여요.
          </p>

          <h3 className="settings-sub">더 숨기기</h3>
          <label className="settings-toggle">
            <span>
              <strong>자동 위장</strong>
              <small>다른 창으로 가거나 마우스가 창 밖으로 나가면 바로 바꿔요</small>
            </span>
            <input
              type="checkbox"
              className="switch"
              checked={settings.boss_auto}
              onChange={(event) => void save({ boss_auto: event.target.checked })}
            />
          </label>
          <label className="settings-toggle">
            <span>
              <strong>돌아올 때 잠그기</strong>
              <small>위장 화면에서 돌아오면 비밀번호를 다시 물어요</small>
            </span>
            <input
              type="checkbox"
              className="switch"
              checked={settings.boss_relock}
              onChange={(event) => void save({ boss_relock: event.target.checked })}
            />
          </label>
        </section>
      </div>
    </div>
  );
}

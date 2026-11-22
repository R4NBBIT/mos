import BackIcon from "./BackIcon";
import { type ReactNode, useEffect, useState } from "react";
import { updateSettings } from "./api";
import BossKeyPicker from "./BossKeyPicker";
import { bossKeyLabel, parseBossKey } from "./boss/bossKey";
import DisguiseSettings from "./boss/DisguiseSettings";
import { isTouchOnly } from "./device";
import {
  defaultTitle,
  LOCK_MINUTES,
  lockLabel,
  type ReactionsView,
  type Settings,
  type MediaView,
  type StickersView,
  THEMES,
  type Theme,
  type HiddenNotify,
} from "./theme";
import { playSound, readSound, saveSound, useSound } from "./notifySound";
import { useNotifyPrefs } from "./notifyPrefs";
import { saveBossDevice, useBossDevice } from "./bossDevice";
import Scope from "./Scope";
import { saveTextSize, TEXT_SIZES, type TextSize, useTextSize } from "./textSize";
import { askPopupPermission, popupSupport, type PopupSupport } from "./useNotifications";
import { disablePush, enablePush, pushState, type PushState } from "./webPush";

const POPUP_TEXT: Record<PopupSupport, string> = {
  granted: "이 브라우저에서 알림 창을 띄울 수 있어요.",
  default: "알림 창을 띄우려면 이 브라우저에서 한 번 허용해 주세요.",
  denied: "이 브라우저에서 알림 창이 막혀 있어요. 주소창 왼쪽 자물쇠(사이트 설정)에서 알림을 '허용'으로 바꿔 주세요.",
  unsupported: "이 브라우저(휴대폰 등)에서는 알림 창을 띄울 수 없어요. 탭 제목 숫자로만 알려요.",
};

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
  if (theme === "note") {
    return (
      <div className="theme-preview theme-preview-note" aria-hidden="true">
        <span className="side" />
        <span className="page">
          <b />
          <i style={{ width: "80%" }} />
          <i style={{ width: "65%" }} />
          <i style={{ width: "72%" }} />
        </span>
      </div>
    );
  }
  if (theme === "word") {
    return (
      <div className="theme-preview theme-preview-word" aria-hidden="true">
        <span className="bar" />
        <span className="page">
          <b />
          <i style={{ width: "85%", borderColor: "#1f5fa8" }} />
          <i style={{ width: "70%", borderColor: "#a3620a" }} />
          <i style={{ width: "78%", borderColor: "#2f6b2f" }} />
        </span>
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
  /** 내 파일을 불러오거나 지웠을 때 */
  onFileChanged: () => void;
}

// 숨긴 서버와 채널: 알림(기기마다)과 목록 숫자(계정 전체)를 따로 정한다
const HIDDEN_NOTIFY_CHOICES: Choice<HiddenNotify>[] = [
  { value: "none", label: "알리지 않기", note: "숨긴 곳은 나를 불러도 알리지 않아요." },
  {
    value: "mentions",
    label: "나를 부른 메시지만 (기본)",
    note: "숨긴 곳에서는 @내 이름이 들어간 글과 내 글에 단 답장만 알려요.",
  },
  {
    value: "all",
    label: "숨기지 않은 곳과 같게",
    note: "위 '알려 줄 메시지'를 그대로 따라요. 숨기기는 목록 정리에만 쓰는 거예요.",
  },
];

const HIDDEN_UNREAD_CHOICES: Choice<HiddenNotify>[] = [
  { value: "none", label: "세지 않기", note: "서버 숫자와 '숨긴 항목' 묶음에 아무 숫자도 붙이지 않아요." },
  {
    value: "mentions",
    label: "나를 부른 메시지만 세기 (기본)",
    note: "나를 부른 메시지가 있을 때만 '@ 숫자'로 보여요.",
  },
  { value: "all", label: "모두 세기", note: "숨기지 않은 곳처럼 새 메시지 수를 모두 세요." },
];

const HIDDEN_SCOPE_NOTE =
  "숨긴 서버는 그 서버의 모든 채널, 숨긴 채널은 그 채널의 스레드와 글까지 같은 규칙이에요. 숨기기와 다시 보이기는 목록 아래 '목록 편집'에서 해요.";

interface Choice<T extends string> {
  value: T;
  label: string;
  note: string;
}

/** 고르기(라디오) 목록: 고를 것마다 한 줄 설명 */
function ChoiceList<T extends string>({
  name,
  label,
  choices,
  value,
  onChange,
}: {
  name: string;
  label: string;
  choices: Choice<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="boss-choices choice-list" role="radiogroup" aria-label={label}>
      {choices.map((choice) => (
        <label key={choice.value} className="boss-choice choice-row">
          <input type="radio" name={name} checked={value === choice.value} onChange={() => onChange(choice.value)} />
          <span className="choice-text">
            <span>{choice.label}</span>
            <small>{choice.note}</small>
          </span>
        </label>
      ))}
    </div>
  );
}

export default function SettingsScreen({ settings, onChange, onBack, menu, onFileChanged }: Props) {
  const [title, setTitle] = useState(settings.tab_title ?? "");
  const textSize = useTextSize();
  const sound = useSound();
  const [error, setError] = useState("");
  const [popup, setPopup] = useState<PopupSupport>(popupSupport);
  const [push, setPush] = useState<PushState>("off");
  const [pushBusy, setPushBusy] = useState(false);
  const { prefs: device, save: saveDevice } = useNotifyPrefs();
  const bossDevice = useBossDevice({
    auto: settings.boss_auto,
    fullscreen: settings.boss_fullscreen,
    relock: settings.boss_relock,
  });
  useEffect(() => {
    pushState()
      .then(setPush)
      .catch(() => setPush("unsupported"));
  }, []);
  const togglePush = async (on: boolean) => {
    setPushBusy(true);
    setError("");
    try {
      setPush(on ? await enablePush() : await disablePush());
      setPopup(popupSupport());
    } catch {
      setError("웹 푸시를 바꾸지 못했어요. 잠시 후 다시 해 주세요.");
    } finally {
      setPushBusy(false);
    }
  };
  const touchOnly = isTouchOnly();

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
          <BackIcon />
        </button>
        <div className="room-title">
          <strong>{settings.theme === "word" ? "옵션" : "설정"}</strong>
        </div>
        {menu}
      </header>
      <div className="list-body settings">
        {error && <p className="list-error">{error}</p>}
        <p className="scope-legend">
          <Scope /> 계정에 저장돼 어느 기기에서 열어도 같아요. <Scope device /> 지금 쓰는 이 기기(브라우저나 설치한
          앱)에만 적용돼요.
        </p>
        <section className="settings-card">
          <h2 className="settings-title">테마 <Scope /></h2>
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
                  {item.id === settings.theme ? " (사용 중)" : ""}
                </span>
              </button>
            ))}
          </div>
          <p className="settings-note">
            고르는 즉시 바뀌고, 이 계정에 기억돼요. 탭 제목과 아이콘도 테마에 맞춰 바뀌어요.
          </p>
        </section>

        <section className="settings-card">
          <h2 className="settings-title">표시</h2>
          <label className="settings-toggle">
            <span>
              <strong>작성자 프로필 사진 보이기 <Scope /></strong>
              <small>끄면 모든 테마에서 메시지 옆 프로필 사진을 숨기고 이름만 보여요</small>
            </span>
            <input
              type="checkbox"
              className="switch"
              checked={settings.show_avatars}
              onChange={(event) => void save({ show_avatars: event.target.checked })}
            />
          </label>
          <label className="settings-toggle">
            <span>
              <strong>반응 <Scope /></strong>
              <small>작게는 반응 개수만 흐린 +n으로 보여요</small>
            </span>
            <select
              className="settings-select"
              aria-label="반응 표시"
              value={settings.reactions_view}
              onChange={(event) =>
                void save({
                  reactions_view: event.target.value as ReactionsView,
                })
              }
            >
              <option value="full">그대로</option>
              <option value="compact">작게(+n)</option>
              <option value="hidden">숨기기</option>
            </select>
          </label>
          <label className="settings-toggle">
            <span>
              <strong>스티커와 큰 이모지 <Scope /></strong>
              <small>작게는 작은 그림으로 멈춰 보이고, 숨기기는 이름 글자로만 보여요</small>
            </span>
            <select
              className="settings-select"
              aria-label="스티커와 큰 이모지 표시"
              value={settings.stickers_view}
              onChange={(event) => void save({ stickers_view: event.target.value as StickersView })}
            >
              <option value="full">그대로</option>
              <option value="small">작게</option>
              <option value="hidden">숨기기</option>
            </select>
          </label>
          <label className="settings-toggle">
            <span>
              <strong>사진과 동영상 <Scope /></strong>
              <small>작게는 작은 그림으로 보이고, 숨기기는 파일 이름 글자로만 보여요</small>
            </span>
            <select
              className="settings-select"
              aria-label="사진과 동영상 표시"
              value={settings.media_view}
              onChange={(event) => void save({ media_view: event.target.value as MediaView })}
            >
              <option value="full">그대로</option>
              <option value="small">작게</option>
              <option value="hidden">숨기기</option>
            </select>
          </label>
          <label className="settings-toggle">
            <span>
              <strong>글자 크기 <Scope device /></strong>
              <small>대화 글씨만 바뀌어요. 이 브라우저에만 저장돼서 휴대폰과 컴퓨터를 따로 정할 수 있어요</small>
            </span>
            <select
              className="settings-select"
              aria-label="글자 크기"
              value={textSize}
              onChange={(event) => saveTextSize(Number(event.target.value) as TextSize)}
            >
              {TEXT_SIZES.map((size) => (
                <option key={size.value} value={size.value}>
                  {size.label} ({size.value}%)
                </option>
              ))}
            </select>
          </label>
          <label className="settings-toggle">
            <span>
              <strong>음성 채널 보이기 <Scope /></strong>
              <small>왼쪽 목록에 음성 채널과 지금 들어가 있는 사람을 보여요. 여기서 듣거나 말할 수는 없어요</small>
            </span>
            <input
              type="checkbox"
              className="switch"
              checked={settings.voice_view}
              onChange={(event) => void save({ voice_view: event.target.checked })}
            />
          </label>
          <div className="settings-item">
            <h3 className="settings-sub">숨긴 서버와 채널의 안 읽은 수 <Scope /></h3>
            <ChoiceList
              name="hidden-unread"
              label="숨긴 서버와 채널의 안 읽은 수"
              choices={HIDDEN_UNREAD_CHOICES}
              value={settings.hidden_unread}
              onChange={(value) => void save({ hidden_unread: value })}
            />
            <p className="settings-item-note">
              {HIDDEN_SCOPE_NOTE} 이 값은 계정에 저장돼 모든 기기에서 같아요. 알림은 '알림'에서 기기마다 따로 정해요.
            </p>
          </div>
        </section>

        <section className="settings-card">
          <h2 className="settings-title">탭 제목 <Scope /></h2>
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
          <p className="settings-note">
            비워 두면 테마 기본값({defaultTitle(settings.theme)})을 써요. 잠금 화면 제목도 같이 바뀌어요.
          </p>
        </section>

        <section className="settings-card">
          <h2 className="settings-title">잠금 <Scope /></h2>
          <div className="settings-item">
            <label className="settings-toggle">
              <span>
                <strong>자동 잠금</strong>
                <small>이 시간 동안 아무것도 안 하면 잠겨서 비밀번호를 다시 물어요</small>
              </span>
              <select
                className="settings-select"
                aria-label="자동 잠금 시간"
                value={settings.lock_minutes}
                onChange={(event) => void save({ lock_minutes: Number(event.target.value) })}
              >
                {LOCK_MINUTES.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {lockLabel(minutes)}
                  </option>
                ))}
              </select>
            </label>
            <p className="settings-item-note">
              잠금 해제할 때 '로그인 유지'를 고르면 이 브라우저에서는 30일 동안 잠기지 않아요. 계정 메뉴 › 잠그기로 바로
              잠글 수도 있어요.
            </p>
          </div>
        </section>

        <section className="settings-card">
          <h2 className="settings-title">알림 <Scope device /></h2>
          <p className="settings-lead settings-lead-small">
            알림은 이 기기(브라우저)에만 적용돼요. 회사 컴퓨터는 끄고 휴대폰만 켜 두는 식으로 기기마다 따로 정할 수 있어요.
          </p>
          <div className="settings-item">
            <label className="settings-toggle">
              <span>
                <strong>알림 받기</strong>
                <small>새 알림이 오면 탭 제목 앞에 숫자를 붙여요. 보고 있지 않은 채널의 메시지는 화면 위 작은 알림으로, 다른 창을 보고 있으면 알림 창으로 알려요</small>
              </span>
              <input
                type="checkbox"
                className="switch"
                checked={device.notify}
                onChange={(event) => void saveDevice({ notify: event.target.checked })}
              />
            </label>
            {device.notify && (
              <p className="settings-item-note">
                {push === "on"
                  ? "탭이 열려 있으면 탭에서, 닫혀 있으면 브라우저가 알려요."
                  : "이 화면이 탭으로 열려 있는 동안만 알려요."}{" "}
                위장 화면 중에는 알림 창을 띄우지 않아요.
                {push === "unsupported" && " 아이폰은 사파리에서 '홈 화면에 추가'한 뒤에만 알림을 받을 수 있어요."}
              </p>
            )}
          </div>
          {device.notify && (
            <>
              <div className="settings-item">
                <h3 className="settings-sub">알려 줄 메시지</h3>
                <div className="boss-choices" role="radiogroup" aria-label="알려 줄 메시지">
                  <label className="boss-choice">
                    <input
                      type="radio"
                      name="notify-scope"
                      checked={device.scope === "mentions"}
                      onChange={() => void saveDevice({ scope: "mentions" })}
                    />
                    나를 부른 메시지만
                  </label>
                  <label className="boss-choice">
                    <input
                      type="radio"
                      name="notify-scope"
                      checked={device.scope === "pinned"}
                      onChange={() => void saveDevice({ scope: "pinned" })}
                    />
                    나를 부른 메시지 + 고정한 채널의 새 메시지
                  </label>
                  <label className="boss-choice">
                    <input
                      type="radio"
                      name="notify-scope"
                      checked={device.scope === "all"}
                      onChange={() => void saveDevice({ scope: "all" })}
                    />
                    모든 새 메시지(볼 수 있는 모든 채널)
                  </label>
                </div>
                <p className="settings-item-note">나를 부른 메시지는 @내 이름이 들어간 글과 내 글에 단 답장이에요.</p>
              </div>
              <div className="settings-item">
                <h3 className="settings-sub">숨긴 서버와 채널의 알림</h3>
                <ChoiceList
                  name="hidden-notify"
                  label="숨긴 서버와 채널의 알림"
                  choices={HIDDEN_NOTIFY_CHOICES}
                  value={device.hidden}
                  onChange={(value) => void saveDevice({ hidden: value })}
                />
                <p className="settings-item-note">{HIDDEN_SCOPE_NOTE}</p>
              </div>
              <div className="settings-item">
                <label className="settings-toggle">
                  <span>
                    <strong>알림 창에 보낸 사람과 내용 보이기</strong>
                    <small>끄면 알림 창에는 '새 알림 n건', 화면 안 알림에는 채널 이름만 보여서 옆에서 봐도 티가 덜 나요</small>
                  </span>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={device.preview}
                    onChange={(event) => void saveDevice({ preview: event.target.checked })}
                  />
                </label>
                <p className="settings-item-note">{POPUP_TEXT[popup]}</p>
                {popup === "default" && (
                  <div className="settings-buttons">
                    <button
                      type="button"
                      className="pill-button pill-button-strong"
                      onClick={() => void askPopupPermission().then(setPopup)}
                    >
                      이 브라우저에서 알림 허용하기
                    </button>
                  </div>
                )}
              </div>
              <div className="settings-item">
                <label className="settings-toggle">
                  <span>
                    <strong>알림 소리</strong>
                    <small>새 알림이 오면 짧게 '띵' 소리를 내요. 위장 화면 중에는 울리지 않아요</small>
                  </span>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={sound.on}
                    onChange={(event) => saveSound({ ...sound, on: event.target.checked })}
                  />
                </label>
                {sound.on && (
                  <div className="settings-volume">
                    <label htmlFor="notify-volume">음량</label>
                    <input
                      id="notify-volume"
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={sound.volume}
                      onChange={(event) => saveSound({ ...sound, volume: Number(event.target.value) })}
                      onPointerUp={() => playSound(readSound(), true)}
                      onKeyUp={() => playSound(readSound(), true)}
                    />
                    <output htmlFor="notify-volume">{sound.volume}</output>
                    <button type="button" className="text-button" onClick={() => playSound(sound, true)}>
                      들어 보기
                    </button>
                  </div>
                )}
              </div>
              {push !== "unsupported" && (
                <div className="settings-item">
                  <label className="settings-toggle">
                    <span>
                      <strong>탭을 닫아도 알림 받기</strong>
                      <small>
                        {push === "denied"
                          ? "브라우저에서 알림이 막혀 있어요. 주소창 왼쪽 자물쇠에서 알림을 허용해 주세요."
                          : "브라우저만 켜져 있으면 이 탭을 닫아도 알려요. 휴대폰 크롬에서도 돼요."}
                      </small>
                    </span>
                    <input
                      type="checkbox"
                      className="switch"
                      checked={push === "on"}
                      disabled={pushBusy || push === "denied"}
                      onChange={(event) => void togglePush(event.target.checked)}
                    />
                  </label>
                </div>
              )}
            </>
          )}
        </section>

        <section className="settings-card">
          <h2 className="settings-title">위장 화면</h2>
          {touchOnly && (
            <p className="settings-warn">
              휴대폰과 태블릿에는 키보드가 없어 보스키를 쓸 수 없어요. 대신 화면 왼쪽 아래 모서리를 누르면 위장 화면으로
              바뀌어요. 아래 보스키 설정은 컴퓨터에서 쓸 때 적용돼요.
            </p>
          )}
          {!touchOnly && (
            <p className="settings-note settings-lead">
              어느 화면에서든 보스키(
              {bossKeyLabel(parseBossKey(settings.boss_key))})를 누르면 업무 화면으로 바뀌고, 한 번 더 누르면 돌아와요. 화면
              왼쪽 아래 모서리를 눌러도 돼요.
            </p>
          )}
          <div className="settings-item">
            <BossKeyPicker value={settings.boss_key} onSave={(value) => void save({ boss_key: value })} />
          </div>

          <DisguiseSettings settings={settings} save={save} onFileChanged={onFileChanged} />

          <h3 className="settings-sub settings-sub-line">더 숨기기 <Scope device /></h3>
          <label className="settings-toggle">
            <span>
              <strong>자동 위장</strong>
              <small>다른 창으로 가거나 마우스가 창 밖으로 나가면 바로 바꿔요</small>
            </span>
            <input
              type="checkbox"
              className="switch"
              checked={bossDevice.auto}
              onChange={(event) => saveBossDevice(bossDevice, { auto: event.target.checked })}
            />
          </label>
          <label className="settings-toggle">
            <span>
              <strong>위장할 때 전체 화면으로</strong>
              <small>주소창과 탭까지 가려서 진짜 프로그램처럼 보여요(돌아오면 원래 크기로)</small>
            </span>
            <input
              type="checkbox"
              className="switch"
              checked={bossDevice.fullscreen}
              onChange={(event) => saveBossDevice(bossDevice, { fullscreen: event.target.checked })}
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
              checked={bossDevice.relock}
              onChange={(event) => saveBossDevice(bossDevice, { relock: event.target.checked })}
            />
          </label>
        </section>
      </div>
    </div>
  );
}

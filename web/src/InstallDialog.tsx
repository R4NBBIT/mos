// 계정 메뉴 › '앱으로 설치': 홈 화면 이름과 아이콘을 고르고, 기기에 맞는 설치 방법과
// 나중에 바꾸는 방법까지 한 창에서 안내한다. 카카오톡 같은 앱 안의 브라우저면 바깥 브라우저로 보낸다
import { useEffect, useState } from "react";
import {
  APP_ICONS,
  APP_NAME_MAX,
  canPromptInstall,
  cleanAppName,
  DEFAULT_APP_NAME,
  externalOpenUrl,
  inAppBrowser,
  isStandalone,
  platform,
  promptInstall,
  readAppChoice,
  saveAppChoice,
} from "./appInstall";

const CHANGE_HELP = {
  ios: "홈 화면의 앱 아이콘을 길게 눌러 '앱 삭제'로 지운 뒤, 이 창에서 다시 정하고 홈 화면에 추가하면 돼요.",
  android: "앱 아이콘을 길게 눌러 '제거'(또는 앱 정보 › 제거)한 뒤, 이 창에서 다시 정하고 설치하면 돼요.",
  desktop: "앱 창 오른쪽 위 메뉴(⋮) › 제거로 지운 뒤, 이 창에서 다시 정하고 설치하면 돼요.",
} as const;

function ShareIcon() {
  return (
    <svg className="install-inline-icon" width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 3v10M6.5 6.5L10 3l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 9.5H4v8h12v-8h-1" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

export default function InstallDialog({ onClose, closing }: { onClose: () => void; closing: boolean }) {
  const saved = readAppChoice();
  const [name, setName] = useState(saved.name);
  const [icon, setIcon] = useState(saved.icon);
  const [result, setResult] = useState<"" | "accepted" | "dismissed" | "manual">("");
  const [copied, setCopied] = useState(false);
  const device = platform();
  const inApp = inAppBrowser();
  const standalone = isStandalone();
  const cleanName = cleanAppName(name) || DEFAULT_APP_NAME;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const choice = { name: cleanName, icon };
  const install = async () => {
    if (device === "ios" || !canPromptInstall()) {
      saveAppChoice(choice); // 아이폰은 홈 화면에 추가할 때 이 이름과 아이콘을 쓴다
      setResult("manual");
      return;
    }
    const outcome = await promptInstall(choice);
    setResult(outcome === "unavailable" ? "manual" : outcome);
  };
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.origin + "/");
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const external = inApp ? externalOpenUrl(inApp) : null;

  return (
    <div
      className={closing ? "guide-layer guide-layer-out" : "guide-layer"}
      role="dialog"
      aria-modal="true"
      aria-labelledby="install-title"
      inert={closing}
    >
      <div className="guide-card install-card">
        <div className="guide-top">
          <span className="guide-step">홈 화면에 앱처럼</span>
          <button type="button" className="guide-skip" onClick={onClose}>
            닫기
          </button>
        </div>
        <h2 id="install-title" className="guide-title">
          앱으로 설치
        </h2>
        <div className="guide-body install-body">
          {inApp ? (
            <div className="install-warn">
              <p>
                {inApp.name} 안의 브라우저에서는 설치할 수 없어요. {device === "ios" ? "사파리로" : "크롬으로"} 열어서 다시 눌러
                주세요.
              </p>
              {!external && <p>오른쪽 위(또는 아래) 메뉴에서 'Safari로 열기'나 '다른 브라우저로 열기'를 눌러 주세요.</p>}
            </div>
          ) : (
            <>
              {standalone && <p className="install-note">지금 앱으로 쓰고 있어요. 다른 기기에 설치하거나 다시 설치할 때 써요.</p>}
              {device === "ios" && !standalone && (
                <p className="install-note">이미 홈 화면에 추가했다면 거기서 열면 돼요.</p>
              )}
              <label className="install-field">
                <span>홈 화면 이름</span>
                <input
                  value={name}
                  maxLength={APP_NAME_MAX + 10}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={DEFAULT_APP_NAME}
                />
                <small>{APP_NAME_MAX}자까지. 비우면 'ㅁㅇㅅ'</small>
              </label>
              <fieldset className="install-field install-icons">
                <legend>아이콘</legend>
                <div className="install-icon-grid" role="radiogroup" aria-label="아이콘">
                  {APP_ICONS.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      role="radio"
                      aria-checked={icon === item.key}
                      aria-label={item.label}
                      title={item.label}
                      className={icon === item.key ? "install-icon install-icon-on" : "install-icon"}
                      onClick={() => setIcon(item.key)}
                    >
                      <img src={`/app-icons/${item.key}.svg`} alt="" width="44" height="44" />
                    </button>
                  ))}
                </div>
              </fieldset>

              {result === "accepted" && <p className="install-ok">설치했어요. 홈 화면(앱 목록)의 '{cleanName}' 아이콘을 누르면 열려요.</p>}
              {result === "dismissed" && <p className="install-note">설치를 취소했어요. 다시 누르면 돼요.</p>}
              {result === "manual" && (
                <div className="install-steps">
                  {device === "ios" ? (
                    <ol>
                      <li>
                        사파리 아래쪽(아이패드는 위쪽)의 공유 단추 <ShareIcon />를 눌러요.
                      </li>
                      <li>목록을 내려 '홈 화면에 추가'를 눌러요.</li>
                      <li>이름 칸이 '{cleanName}'인지 보고 '추가'를 눌러요.</li>
                    </ol>
                  ) : device === "android" ? (
                    <ol>
                      <li>브라우저 오른쪽 위 메뉴(⋮)를 눌러요.</li>
                      <li>'앱 설치' 또는 '홈 화면에 추가'를 눌러요.</li>
                      <li>메뉴에 없으면 이미 설치돼 있을 수 있어요. 앱 목록에서 찾아 주세요.</li>
                    </ol>
                  ) : (
                    <ol>
                      <li>주소창 오른쪽의 설치 아이콘, 또는 브라우저 메뉴 › '앱 설치'(크롬, 엣지)를 눌러요.</li>
                      <li>보이지 않으면 이미 설치돼 있거나 이 브라우저가 지원하지 않는 거예요. 크롬이나 엣지에서 열어 주세요.</li>
                    </ol>
                  )}
                </div>
              )}

              <div className="install-later">
                <strong>나중에 이름이나 아이콘을 바꾸려면</strong>
                <p>{CHANGE_HELP[device]}</p>
              </div>
            </>
          )}
        </div>
        <div className="guide-actions">
          <button type="button" className="pill-button" onClick={onClose}>
            취소
          </button>
          {inApp ? (
            external ? (
              <a className="pill-button pill-button-strong install-open" href={external}>
                {device === "ios" ? "사파리로" : "크롬으로"} 열기
              </a>
            ) : (
              <button type="button" className="pill-button pill-button-strong" onClick={() => void copyLink()}>
                {copied ? "주소를 복사했어요" : "주소 복사"}
              </button>
            )
          ) : (
            <button type="button" className="pill-button pill-button-strong" onClick={() => void install()}>
              {device === "ios" ? "설치 방법 보기" : "설치하기"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// 계정 메뉴 › 'TODO 위젯 받기': 안드로이드 홈 화면 TODO 위젯 APK 내려받기 창(TODO를 쓸 수 있는 계정, 아이폰 아님).
// '앱으로 설치'(ㅁㅇㅅ 웹앱)와 헷갈리지 않게 따로 연다(2026-11-23 사용자 요청).
// APK는 android 워크플로가 정식 서명으로 만들어 배포 때 함께 올라온다
import { useEffect, useState } from "react";
import { ANDROID_APK_URL, type AndroidApk, fetchAndroidApk } from "./todoApi";

export default function AndroidWidgetDialog({ onClose, closing }: { onClose: () => void; closing: boolean }) {
  const [apk, setApk] = useState<AndroidApk | null>(null);
  const desktop = !/Android/i.test(navigator.userAgent);
  useEffect(() => {
    let stopped = false;
    fetchAndroidApk()
      .then((value) => !stopped && setApk(value))
      .catch(() => !stopped && setApk({ available: false, size: 0, updated: null }));
    return () => {
      stopped = true;
    };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const size = apk?.size ? `${(apk.size / 1024 / 1024).toFixed(1)}MB` : "";
  return (
    <div
      className={closing ? "guide-layer guide-layer-out" : "guide-layer"}
      role="dialog"
      aria-modal="true"
      aria-labelledby="widget-apk-title"
      inert={closing}
    >
      <div className="guide-card install-card">
        <div className="guide-top">
          <span className="guide-step">안드로이드 홈 화면</span>
          <button type="button" className="guide-skip" onClick={onClose}>
            닫기
          </button>
        </div>
        <h2 id="widget-apk-title" className="guide-title">
          TODO 위젯 받기
        </h2>
        <div className="guide-body install-body">
          <p className="install-note">
            ㅁㅇㅅ 앱과는 따로인, 홈 화면에 오늘 TODO만 띄우는 작은 앱이에요. 안드로이드 휴대폰에서만 쓸 수 있어요.
          </p>
          {apk === null && <p className="install-note">확인하는 중…</p>}
          {apk && !apk.available && <p className="install-note">아직 올라온 APK가 없어요.</p>}
          {apk?.available && (
            <div className="install-steps">
              <ol>
                <li>아래 'APK 받기'를 눌러 받아요{desktop ? "(휴대폰에서 이 창을 열면 바로 설치할 수 있어요)" : ""}.</li>
                <li>받은 파일을 열어 설치해요. '출처를 알 수 없는 앱 설치'를 허용해 달라고 나올 수 있어요.</li>
                <li>앱을 열고 'ㅁㅇㅅ로 로그인'을 눌러요.</li>
                <li>홈 화면을 길게 눌러 위젯 › TODO를 추가해요.</li>
              </ol>
            </div>
          )}
        </div>
        <div className="guide-actions">
          <button type="button" className="pill-button" onClick={onClose}>
            닫기
          </button>
          {apk?.available && (
            <a
              className="pill-button pill-button-strong install-open"
              href={ANDROID_APK_URL}
              download="mos-todo-widget.apk"
            >
              APK 받기{size ? ` (${size})` : ""}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

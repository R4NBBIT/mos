// '앱으로 설치' 창 아래: 안드로이드 홈 화면 TODO 위젯 APK 내려받기(TODO를 쓸 수 있는 계정만, 2026-11-23 사용자 요청).
// APK는 android 워크플로가 정식 서명으로 만들어 배포 때 함께 올라온다
import { useEffect, useState } from "react";
import { useTodoAllowed } from "./feature";
import { ANDROID_APK_URL, type AndroidApk, fetchAndroidApk } from "./todoApi";

export default function AndroidWidgetDownload({ device }: { device: "ios" | "android" | "desktop" }) {
  const allowed = useTodoAllowed();
  const [apk, setApk] = useState<AndroidApk | null>(null);
  useEffect(() => {
    if (!allowed || device === "ios") return;
    let stopped = false;
    fetchAndroidApk()
      .then((value) => !stopped && setApk(value))
      .catch(() => !stopped && setApk({ available: false, size: 0, updated: null }));
    return () => {
      stopped = true;
    };
  }, [allowed, device]);
  if (!allowed || device === "ios" || apk === null) return null;
  const size = apk.size ? `${(apk.size / 1024 / 1024).toFixed(1)}MB` : "";
  return (
    <div className="install-later install-android">
      <strong>안드로이드 홈 화면 TODO 위젯</strong>
      {apk.available ? (
        <>
          <p>
            홈 화면에 오늘 TODO를 띄우는 작은 앱이에요. 받아서 설치한 뒤 앱에서 'ㅁㅇㅅ로 로그인'을 누르고, 홈 화면을 길게 눌러
            위젯 › TODO를 추가해요.{device === "desktop" ? " 휴대폰에서 이 창을 열어 받으면 바로 설치할 수 있어요." : ""}
          </p>
          <p className="install-android-row">
            <a className="pill-button" href={ANDROID_APK_URL} download="mos-todo-widget.apk">
              APK 받기
            </a>
            {size && <small>{size}</small>}
          </p>
          <p>설치할 때 '출처를 알 수 없는 앱 설치'를 허용해 달라고 나올 수 있어요.</p>
        </>
      ) : (
        <p>아직 올라온 APK가 없어요.</p>
      )}
    </div>
  );
}

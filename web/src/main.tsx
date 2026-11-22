import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { applyAppChoice, watchInstallPrompt } from "./appInstall";
import { applyTextSize } from "./textSize";
import { registerWorker } from "./webPush";

applyTextSize();
applyAppChoice(); // 홈 화면 앱으로 설치할 때 쓸 이름과 아이콘(이 브라우저에서 고른 것, 기본 ㅁㅇㅅ)
watchInstallPrompt();

registerWorker();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

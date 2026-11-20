import { useEffect, useState } from "react";
import { checkSession } from "./api";
import ChatRoom from "./ChatRoom";
import LoginBox from "./LoginBox";

type Stage = "checking" | "login" | "ready" | "error";

export default function App() {
  const [stage, setStage] = useState<Stage>("checking");

  useEffect(() => {
    checkSession()
      .then((ok) => setStage(ok ? "ready" : "login"))
      .catch(() => setStage("error"));
  }, []);

  if (stage === "checking") {
    return <div className="center-note">불러오는 중…</div>;
  }
  if (stage === "error") {
    return <div className="center-note">서버에 연결할 수 없어요. 잠시 후 새로고침해 주세요.</div>;
  }
  if (stage === "login") {
    return <LoginBox onDone={() => setStage("ready")} />;
  }
  return <ChatRoom onLoggedOut={() => setStage("login")} />;
}

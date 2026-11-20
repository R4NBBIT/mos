import { type FormEvent, useState } from "react";
import { ApiError, login } from "./api";

interface Props {
  onDone: () => void;
}

/** 2단계 임시 로그인(운영자 열쇠). 3단계에서 디스코드 연결·앱 비밀번호로 바뀐다. */
export default function LoginBox({ onDone }: Props) {
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!key || busy) return;
    setBusy(true);
    setError("");
    try {
      await login(key);
      setKey("");
      onDone();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 429) {
        setError("여러 번 틀려서 잠겼어요. 10분 뒤에 다시 해 주세요.");
      } else if (caught instanceof ApiError && caught.status === 401) {
        setError("열쇠가 맞지 않아요.");
      } else {
        setError("서버에 연결할 수 없어요.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <form className="login-box" onSubmit={submit}>
        <h1>작업 메모</h1>
        <p className="login-hint">운영자 열쇠를 입력하세요.</p>
        <input
          type="password"
          autoComplete="current-password"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          aria-label="운영자 열쇠"
          autoFocus
        />
        {error && <p className="login-error">{error}</p>}
        <button type="submit" disabled={!key || busy}>
          {busy ? "확인 중…" : "들어가기"}
        </button>
      </form>
    </div>
  );
}

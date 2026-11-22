// AI 연결 승인 화면(SCR-08): Claude, ChatGPT 커넥터가 TODO에 연결하려 할 때.
// /oauth/authorize가 #/connect/<요청 ID>로 보낸다. 로그인, 잠금 해제가 끝난 뒤에만 보인다.
import { useEffect, useState } from "react";
import { ApiError } from "../api";
import { forgetConnect } from "./feature";
import { decideConnectRequest, fetchConnectRequest } from "./todoApi";
import "./todo.css";

export default function TodoConnect({ requestId, onLeave }: { requestId: string; onLeave: () => void }) {
  const [info, setInfo] = useState<{ client_name: string; redirect_host: string } | null>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  // 휴대폰 앱(위젯)으로 돌아가는 주소: 브라우저가 자동으로 못 열면 눌러서 열게 남겨 둔다
  const [backTo, setBackTo] = useState("");

  useEffect(() => {
    fetchConnectRequest(requestId)
      .then(setInfo)
      .catch((error: unknown) => {
        forgetConnect();
        setProblem(
          error instanceof ApiError && error.status === 410
            ? "연결 요청 시간이 지났어요. AI 앱에서 다시 연결해 주세요."
            : "연결할 수 없는 요청이에요.",
        );
      });
  }, [requestId]);

  const decide = async (allow: boolean) => {
    setBusy(true);
    try {
      const { redirect } = await decideConnectRequest(requestId, allow);
      forgetConnect();
      // 서버가 그 앱에 등록된 주소만 돌려준다(https, 또는 휴대폰 앱의 com.예.앱:/경로).
      // 예전에는 https만 따라가서 위젯 앱으로 돌아가지 못하고 TODO 화면으로만 갔다(2026-11-23 고침)
      const web = /^https?:\/\//.test(redirect);
      const app = /^[a-z][a-z0-9+.-]*:\/[^/]/i.test(redirect) && !/^(javascript|data|vbscript|file):/i.test(redirect);
      if (web || app) {
        if (app) setBackTo(redirect);
        window.location.assign(redirect);
      } else onLeave();
    } catch (error) {
      setBusy(false);
      setProblem(
        error instanceof ApiError && error.status === 409
          ? "연결은 20개까지예요. TODO › AI 연결에서 안 쓰는 연결을 끊어 주세요."
          : "처리하지 못했어요. AI 앱에서 다시 연결해 주세요.",
      );
    }
  };

  return (
    <div className="todo-connect">
      <div className="todo-connect-card" role="dialog" aria-labelledby="todo-connect-title">
        {backTo ? (
          <>
            <h1 id="todo-connect-title">연결했어요</h1>
            <p>앱으로 돌아가지 않으면 아래 단추를 눌러 주세요.</p>
            <div className="todo-connect-actions">
              <a className="todo-small-button todo-primary" href={backTo}>
                앱으로 돌아가기
              </a>
              <button type="button" className="todo-small-button" onClick={onLeave}>
                닫기
              </button>
            </div>
          </>
        ) : problem ? (
          <>
            <h1 id="todo-connect-title">연결할 수 없어요</h1>
            <p>{problem}</p>
            <div className="todo-connect-actions">
              <button type="button" className="todo-small-button" onClick={onLeave}>
                돌아가기
              </button>
            </div>
          </>
        ) : info === null ? (
          <p>불러오는 중…</p>
        ) : (
          <>
            <h1 id="todo-connect-title">{info.client_name}을(를) TODO에 연결할까요?</h1>
            <p className="todo-connect-host">돌아갈 곳: {info.redirect_host}</p>
            <div className="todo-connect-lists">
              <div>
                <strong>할 수 있는 것</strong>
                <ul>
                  <li>카테고리와 TODO 보기</li>
                  <li>TODO 넣기(넣기 전에 대화에서 확인)</li>
                  <li>TODO 수정, 완료 표시</li>
                  <li>방금 넣은 것 되돌리기</li>
                </ul>
                <strong>확인받고 하는 것</strong>
                <ul>
                  <li>TODO 삭제(휴지통에 7일)</li>
                  <li>카테고리 만들기, 바꾸기, 끝내기</li>
                  <li>공개 범위 넓히기는 여기서 한 번 더 승인</li>
                </ul>
              </div>
              <div>
                <strong>할 수 없는 것</strong>
                <ul>
                  <li>ㅁㅇㅅ 메시지 보기</li>
                  <li>디스코드 정보 보기</li>
                  <li>카테고리 삭제</li>
                </ul>
              </div>
            </div>
            <p className="todo-setting-help">
              처음 보는 앱이면 거절하세요. 연결은 TODO › AI 연결에서 언제든 끊을 수 있어요.
            </p>
            <div className="todo-connect-actions">
              <button type="button" className="todo-small-button todo-primary" disabled={busy} onClick={() => void decide(true)}>
                연결
              </button>
              <button type="button" className="todo-small-button" disabled={busy} onClick={() => void decide(false)}>
                거절
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

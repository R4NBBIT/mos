// AI 연결 승인 화면(SCR-08): Claude, ChatGPT 커넥터가 할 일에 연결하려 할 때.
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
      // 서버가 등록된 주소(https)만 돌려준다. 그 앱으로 돌아간다
      if (/^https?:\/\//.test(redirect)) window.location.assign(redirect);
      else onLeave();
    } catch (error) {
      setBusy(false);
      setProblem(
        error instanceof ApiError && error.status === 409
          ? "연결은 20개까지예요. 할 일 › AI 연결에서 안 쓰는 연결을 끊어 주세요."
          : "처리하지 못했어요. AI 앱에서 다시 연결해 주세요.",
      );
    }
  };

  return (
    <div className="todo-connect">
      <div className="todo-connect-card" role="dialog" aria-labelledby="todo-connect-title">
        {problem ? (
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
            <h1 id="todo-connect-title">{info.client_name}을(를) 할 일에 연결할까요?</h1>
            <p className="todo-connect-host">돌아갈 곳: {info.redirect_host}</p>
            <div className="todo-connect-lists">
              <div>
                <strong>할 수 있는 것</strong>
                <ul>
                  <li>카테고리와 할 일 보기</li>
                  <li>할 일 넣기(넣기 전에 대화에서 확인)</li>
                  <li>할 일 수정, 완료 표시</li>
                  <li>방금 넣은 것 되돌리기</li>
                </ul>
                <strong>확인받고 하는 것</strong>
                <ul>
                  <li>할 일 삭제(휴지통에 7일)</li>
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
              처음 보는 앱이면 거절하세요. 연결은 할 일 › AI 연결에서 언제든 끊을 수 있어요.
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

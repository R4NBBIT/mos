// 친구 관리(SCR-06): 받은 요청(수락, 거절), 친구(보기, 끊기), 보낸 요청(취소), 같은 서버 할 일 사용자(요청),
// '친구 요청 받기' 끄고 켜기. 초대 링크, 아이디 검색은 없다(같은 디스코드 서버 사람만)
import { type ReactNode, useCallback, useEffect, useState } from "react";
import BackIcon from "../BackIcon";
import SplitToggle from "../SplitToggle";
import { viaServer } from "../format";
import {
  acceptFriend,
  fetchPeople,
  removeFriend,
  requestFriend,
  setAcceptRequests,
  todoErrorText,
  type TodoPeople,
  type TodoPerson,
} from "./todoApi";
import { GroupsSection } from "./TodoGroups";
import "./todo.css";

function Avatar({ person }: { person: TodoPerson }) {
  return person.avatar_url ? (
    <img className="todo-friend-avatar" src={viaServer(person.avatar_url)} alt="" referrerPolicy="no-referrer" />
  ) : (
    <span className="todo-friend-avatar todo-friend-initial" aria-hidden="true">
      {person.name.slice(0, 1)}
    </span>
  );
}

export default function TodoFriends({
  showBack,
  onBack,
  menu,
  onOpenFriend,
  onChanged,
}: {
  showBack: boolean;
  onBack: () => void;
  menu: ReactNode;
  onOpenFriend: (id: string) => void;
  onChanged: () => void;
}) {
  const [people, setPeople] = useState<TodoPeople | null>(null);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const load = useCallback(
    () =>
      fetchPeople()
        .then(setPeople)
        .catch(() => setError("불러오지 못했어요.")),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const run = async (action: () => Promise<unknown>) => {
    setError("");
    try {
      await action();
      setConfirming(null);
      await load();
      onChanged();
    } catch (failure) {
      setError(todoErrorText(failure));
    }
  };
  const row = (person: TodoPerson, actions: ReactNode, open = false) => (
    <li key={person.id} className="todo-friend-row">
      <Avatar person={person} />
      {open ? (
        <button type="button" className="todo-friend-name todo-link-like" onClick={() => onOpenFriend(person.id)}>
          {person.name}
        </button>
      ) : (
        <span className="todo-friend-name">{person.name}</span>
      )}
      <span className="todo-friend-actions">{actions}</span>
    </li>
  );
  return (
    <div className="room todo-room">
      <header className="room-header">
        <SplitToggle />
        {showBack && (
          <button type="button" className="back-button" onClick={onBack} aria-label="할 일로">
            <BackIcon />
          </button>
        )}
        <div className="room-title">
          <strong>친구</strong>
          <span className="room-sub">같은 디스코드 서버의 할 일 사용자</span>
        </div>
        {menu}
      </header>
      <div className="todo-body">
        {error && <p className="todo-error">{error}</p>}
        {people === null ? (
          <p className="list-note">불러오는 중…</p>
        ) : (
          <>
            {people.incoming.length > 0 && (
              <section className="todo-friend-section">
                <h2 className="todo-friend-title">받은 요청</h2>
                <ul>
                  {people.incoming.map((person) =>
                    row(
                      person,
                      <>
                        <button type="button" className="todo-small-button" onClick={() => void run(() => removeFriend(person.id))}>
                          거절
                        </button>
                        <button
                          type="button"
                          className="todo-small-button todo-primary"
                          onClick={() => void run(() => acceptFriend(person.id))}
                        >
                          수락
                        </button>
                      </>,
                    ),
                  )}
                </ul>
              </section>
            )}
            <section className="todo-friend-section">
              <h2 className="todo-friend-title">친구 {people.friends.length}명</h2>
              {people.friends.length === 0 && <p className="todo-setting-help">아직 친구가 없어요. 아래에서 요청해 보세요.</p>}
              <ul>
                {people.friends.map((person) =>
                  row(
                    person,
                    confirming === person.id ? (
                      <>
                        <button type="button" className="todo-small-button" onClick={() => setConfirming(null)}>
                          취소
                        </button>
                        <button
                          type="button"
                          className="todo-small-button todo-danger"
                          onClick={() => void run(() => removeFriend(person.id))}
                        >
                          끊기
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" className="todo-small-button" onClick={() => onOpenFriend(person.id)}>
                          할 일 보기
                        </button>
                        <button type="button" className="todo-small-button todo-danger-text" onClick={() => setConfirming(person.id)}>
                          끊기
                        </button>
                      </>
                    ),
                    true,
                  ),
                )}
              </ul>
            </section>
            <GroupsSection friends={people.friends} />
            {people.outgoing.length > 0 && (
              <section className="todo-friend-section">
                <h2 className="todo-friend-title">보낸 요청</h2>
                <ul>
                  {people.outgoing.map((person) =>
                    row(
                      person,
                      <button type="button" className="todo-small-button" onClick={() => void run(() => removeFriend(person.id))}>
                        요청 취소
                      </button>,
                    ),
                  )}
                </ul>
              </section>
            )}
            <section className="todo-friend-section">
              <h2 className="todo-friend-title">같은 서버 사람</h2>
              <p className="todo-setting-help">
                이 사람들은 내 '전체' 카테고리를 볼 수 있어요. 친구가 되면 '친구' 카테고리까지 서로 보여요.
              </p>
              {people.candidates.length === 0 && <p className="todo-setting-help">요청을 보낼 수 있는 사람이 없어요.</p>}
              <ul>
                {people.candidates.map((person) =>
                  row(
                    person,
                    <>
                      <button type="button" className="todo-small-button" onClick={() => onOpenFriend(person.id)}>
                        보기
                      </button>
                      <button type="button" className="todo-small-button todo-primary" onClick={() => void run(() => requestFriend(person.id))}>
                        친구 요청
                      </button>
                    </>,
                    true,
                  ),
                )}
              </ul>
            </section>
            <section className="todo-friend-section">
              <div className="todo-setting">
                <span className="todo-setting-name">친구 요청 받기</span>
                <div className="todo-setting-body">
                  <label className="todo-switch">
                    <input
                      type="checkbox"
                      role="switch"
                      checked={people.accept_requests}
                      onChange={(event) => void run(() => setAcceptRequests(event.target.checked))}
                    />
                    <span className="todo-switch-track" aria-hidden="true" />
                    <span>{people.accept_requests ? "켜짐" : "꺼짐"}</span>
                  </label>
                  <p className="todo-setting-help">끄면 같은 서버 사람 목록에 내가 안 보이고 새 요청도 못 받아요.</p>
                </div>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

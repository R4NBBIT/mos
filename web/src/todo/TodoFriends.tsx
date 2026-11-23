// 친구 관리(SCR-06): 받은 요청(수락, 거절), 친구(보기, 끊기), 보낸 요청(취소), 같은 서버 TODO 사용자(요청),
// '친구 요청 받기' 끄고 켜기. 초대 링크, 아이디 검색은 없다(같은 디스코드 서버 사람만)
import { type ReactNode, useCallback, useEffect, useState } from "react";
import BackIcon from "../BackIcon";
import SplitToggle from "../SplitToggle";
import { ApiError } from "../api";
import { viaServer } from "../format";
import {
  acceptFriend,
  blockPerson,
  fetchPeople,
  findPerson,
  removeFriend,
  requestFriend,
  setAcceptRequests,
  todoErrorText,
  type TodoPeople,
  type TodoPerson,
  unblockPerson,
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
  const [adding, setAdding] = useState(false);
  const [blocking, setBlocking] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // 디스코드 아이디로 찾은 사람(요청 가능한 사람 목록은 보여 주지 않음, 2026-11-23 사용자 요청)
  const [found, setFound] = useState<Awaited<ReturnType<typeof findPerson>> | null | "none">(null);
  const [finding, setFinding] = useState(false);
  const find = async () => {
    const username = search.trim().replace(/^@/, "");
    if (!username || finding) return;
    setError("");
    setFinding(true);
    try {
      setFound(await findPerson(username));
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 404) setFound("none");
      else {
        setFound(null);
        setError(todoErrorText(failure));
      }
    } finally {
      setFinding(false);
    }
  };
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
  // 차단: 누르면 한 번 묻고, 친구와 요청을 끊고 서로 안 보이게
  const blockable = (person: TodoPerson, actions: ReactNode): ReactNode =>
    blocking === person.id ? (
      <>
        <span className="todo-friend-ask">비공개로 하면 친구가 끊기고 서로 TODO가 안 보여요.</span>
        <button type="button" className="todo-small-button" onClick={() => setBlocking(null)}>
          취소
        </button>
        <button
          type="button"
          className="todo-small-button todo-danger"
          onClick={() =>
            void run(async () => {
              await blockPerson(person.id);
              setBlocking(null);
            })
          }
        >
          비공개로 하기
        </button>
      </>
    ) : (
      <>
        {actions}
        <button type="button" className="todo-text-button todo-danger-text" onClick={() => setBlocking(person.id)}>
          비공개
        </button>
      </>
    );
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
      <span className="todo-friend-actions">{blockable(person, actions)}</span>
    </li>
  );
  return (
    <div className="room todo-room">
      <header className="room-header todo-header">
        <SplitToggle />
        {showBack && (
          <button type="button" className="back-button" onClick={onBack} aria-label="TODO로">
            <BackIcon />
          </button>
        )}
        <div className="room-title">
          <strong>친구</strong>
          <span className="room-sub">TODO에서만 맺는 친구(디스코드 친구와 따로)</span>
        </div>
        {!showBack && (
          <div className="header-tools">
            <button type="button" className="header-tool" onClick={onBack}>
              <span className="header-tool-label todo-tool-always">TODO로</span>
            </button>
          </div>
        )}
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
                        <button
                          type="button"
                          className="todo-small-button"
                          onClick={() => void run(() => removeFriend(person.id))}
                        >
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
              <div className="todo-friend-head">
                <h2 className="todo-friend-title">친구 {people.friends.length}명</h2>
                <button
                  type="button"
                  className="todo-small-button todo-primary"
                  aria-expanded={adding}
                  onClick={() => setAdding((value) => !value)}
                >
                  {adding ? "닫기" : "친구 추가"}
                </button>
              </div>
              <p className="todo-field-help">
                같은 디스코드 서버에서 TODO를 쓰는 사람에게 디스코드 아이디로 요청할 수 있어요. 친구가 되면 서로 '친구'
                카테고리까지 보이고 반응을 달 수 있어요. 친구가 아니어도 같은 서버 사람은 내 '전체' 카테고리를 볼 수
                있어요(비공개한 사람 빼고).
              </p>
              {adding && (
                <div className="todo-friend-add">
                  <form
                    className="todo-friend-find"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void find();
                    }}
                  >
                    <input
                      className="todo-friend-search"
                      value={search}
                      placeholder="디스코드 아이디"
                      aria-label="요청할 사람의 디스코드 아이디"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      autoFocus
                      onChange={(event) => {
                        setSearch(event.target.value);
                        setFound(null);
                      }}
                    />
                    <button type="submit" className="todo-small-button" disabled={!search.trim() || finding}>
                      찾기
                    </button>
                  </form>
                  <p className="todo-field-help">
                    닉네임이 아니라 디스코드 아이디(사용자명)를 정확히 써야 찾아져요. 같은 디스코드 서버에 있고 TODO를
                    쓰는 사람만 나와요.
                  </p>
                  {found === "none" && <p className="todo-field-help">그 디스코드 아이디인 사람을 찾지 못했어요.</p>}
                  {found && found !== "none" && (
                    <ul>
                      {row(
                        found,
                        found.state === "none" ? (
                          <button
                            type="button"
                            className="todo-small-button todo-primary"
                            onClick={() =>
                              void run(async () => {
                                await requestFriend(found.id);
                                setFound({ ...found, state: "outgoing" });
                              })
                            }
                          >
                            요청
                          </button>
                        ) : found.state === "incoming" ? (
                          <button
                            type="button"
                            className="todo-small-button todo-primary"
                            onClick={() =>
                              void run(async () => {
                                await acceptFriend(found.id);
                                setFound({ ...found, state: "friend" });
                              })
                            }
                          >
                            수락
                          </button>
                        ) : (
                          <span className="todo-field-help">
                            {found.state === "friend" ? "이미 친구예요" : "요청을 보냈어요"}
                          </span>
                        ),
                      )}
                    </ul>
                  )}
                </div>
              )}
              {people.friends.length === 0 && !adding && (
                <p className="todo-field-help">아직 친구가 없어요. '친구 추가'를 눌러 보세요.</p>
              )}
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
                          TODO 보기
                        </button>
                        <button
                          type="button"
                          className="todo-small-button todo-danger-text"
                          onClick={() => setConfirming(person.id)}
                        >
                          끊기
                        </button>
                      </>
                    ),
                    true,
                  ),
                )}
              </ul>
            </section>
            {people.outgoing.length > 0 && (
              <section className="todo-friend-section">
                <h2 className="todo-friend-title">보낸 요청</h2>
                <ul>
                  {people.outgoing.map((person) =>
                    row(
                      person,
                      <button
                        type="button"
                        className="todo-small-button"
                        onClick={() => void run(() => removeFriend(person.id))}
                      >
                        요청 취소
                      </button>,
                    ),
                  )}
                </ul>
              </section>
            )}
            <GroupsSection friends={people.friends} />
            {/* 차단 목록은 비어 있어도 늘 보이게(어디서 푸는지 찾을 수 있게, 2026-11-23) */}
            <section className="todo-friend-section">
              <h2 className="todo-friend-title">비공개한 사람 {people.blocked.length}명</h2>
              <p className="todo-field-help">
                서로 TODO가 안 보이고, 요청과 반응도 할 수 없어요. '비공개 풀기'를 누르면 풀려요(친구는 다시 요청해야
                해요).
              </p>
              {people.blocked.length === 0 && <p className="todo-field-help">비공개한 사람이 없어요.</p>}
              <ul>
                {people.blocked.map((person) => (
                  <li key={person.id} className="todo-friend-row">
                    <Avatar person={person} />
                    <span className="todo-friend-name">{person.name}</span>
                    <span className="todo-friend-actions">
                      <button
                        type="button"
                        className="todo-small-button"
                        onClick={() => void run(() => unblockPerson(person.id))}
                      >
                        비공개 풀기
                      </button>
                    </span>
                  </li>
                ))}
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
                  <p className="todo-setting-help">
                    끄면 다른 사람의 친구 추가 목록에 내가 안 보이고 새 요청도 못 받아요.
                  </p>
                </div>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

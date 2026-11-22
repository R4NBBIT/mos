// 친구 그룹(친구 화면 안): 만들기, 이름 바꾸기, 친구 넣고 빼기, 삭제(확인, 휴지통 7일). 일부 공개에서 그룹째 고를 수 있다
import { useCallback, useEffect, useState } from "react";
import {
  createGroup,
  deleteGroup,
  fetchGroups,
  type TodoGroup,
  type TodoPerson,
  todoErrorText,
  updateGroup,
} from "./todoApi";

function GroupEditor({
  friends,
  group,
  onDone,
  onCancel,
}: {
  friends: TodoPerson[];
  group: TodoGroup | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [members, setMembers] = useState<string[]>(
    group?.members.map((m) => m.id) ?? [],
  );
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const save = async () => {
    setError("");
    try {
      if (group) await updateGroup(group.id, { name: name.trim(), members });
      else await createGroup(name.trim(), members);
      onDone();
    } catch (failure) {
      setError(todoErrorText(failure));
    }
  };
  return (
    <div className="todo-group-editor">
      <input
        className="todo-menu-title"
        aria-label="그룹 이름"
        placeholder="그룹 이름"
        value={name}
        maxLength={20}
        onChange={(event) => setName(event.target.value)}
      />
      <div className="todo-audience-group">
        {friends.length === 0 && (
          <span className="todo-setting-help">친구가 없어요.</span>
        )}
        {friends.map((person) => (
          <label key={person.id} className="todo-audience-item">
            <input
              type="checkbox"
              checked={members.includes(person.id)}
              onChange={() =>
                setMembers((current) =>
                  current.includes(person.id)
                    ? current.filter((id) => id !== person.id)
                    : [...current, person.id],
                )
              }
            />
            <span>{person.name}</span>
          </label>
        ))}
      </div>
      {error && <p className="todo-error">{error}</p>}
      {/* 단추 배치 규칙: 왼쪽 삭제(빨간 글자), 오른쪽 취소, 저장 */}
      <div className="todo-cat-actions">
        <div className="todo-cat-actions-side">
          {group && (
            <button
              type="button"
              className="todo-text-button todo-danger-text"
              onClick={() => setConfirming(true)}
            >
              삭제
            </button>
          )}
        </div>
        <div className="todo-cat-actions-main">
          <button
            type="button"
            className="todo-small-button"
            onClick={onCancel}
          >
            취소
          </button>
          <button
            type="button"
            className="todo-small-button todo-primary"
            disabled={!name.trim()}
            onClick={() => void save()}
          >
            {group ? "저장" : "만들기"}
          </button>
        </div>
      </div>
      {confirming && group && (
        <div
          className="todo-confirm"
          role="alertdialog"
          aria-label="그룹 삭제 확인"
        >
          <span>
            '{group.name}' 그룹을 삭제할까요? 이 그룹으로 일부 공개한 카테고리는
            그룹 사람들이 못 보게 돼요. 휴지통(카테고리 화면 › 휴지통)에서 7일
            동안 되살릴 수 있어요.
          </span>
          <div className="todo-confirm-buttons">
            <button
              type="button"
              className="todo-small-button"
              onClick={() => setConfirming(false)}
            >
              취소
            </button>
            <button
              type="button"
              className="todo-small-button todo-danger"
              onClick={() =>
                void deleteGroup(group.id)
                  .then(onDone)
                  .catch((failure: unknown) => setError(todoErrorText(failure)))
              }
            >
              삭제
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function GroupsSection({ friends }: { friends: TodoPerson[] }) {
  const [groups, setGroups] = useState<TodoGroup[] | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const load = useCallback(() => {
    fetchGroups()
      .then(setGroups)
      .catch(() => setGroups([]));
  }, []);
  useEffect(load, [load, friends]);
  const done = () => {
    setEditing(null);
    load();
  };
  return (
    <section className="todo-friend-section">
      {/* 2026-11-23 사용자 요청: 카테고리 목록처럼 카드 줄, 줄을 누르면 수정, 새 그룹은 + */}
      <div className="todo-friend-head">
        <h2 className="todo-friend-title">
          그룹 {groups ? `${groups.length}개` : ""}
        </h2>
        {editing !== "new" && (
          <button
            type="button"
            className="todo-round-add"
            aria-label="새 그룹"
            title="새 그룹"
            onClick={() => setEditing("new")}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        )}
      </div>
      <p className="todo-field-help">
        카테고리를 '일부'로 공개할 때 그룹째 고를 수 있어요.
      </p>
      {editing === "new" && (
        <GroupEditor
          friends={friends}
          group={null}
          onDone={done}
          onCancel={() => setEditing(null)}
        />
      )}
      {groups && groups.length === 0 && editing !== "new" && (
        <p className="todo-field-help">
          아직 그룹이 없어요. +를 눌러 만들어 보세요.
        </p>
      )}
      <ul className="todo-group-list">
        {(groups ?? []).map((group) =>
          editing === group.id ? (
            <li key={group.id}>
              <GroupEditor
                friends={friends}
                group={group}
                onDone={done}
                onCancel={() => setEditing(null)}
              />
            </li>
          ) : (
            <li key={group.id}>
              <button
                type="button"
                className="todo-group-row"
                onClick={() => setEditing(group.id)}
              >
                <span className="todo-group-text">
                  <strong>{group.name}</strong>
                  <span className="todo-group-members">
                    {group.members.length > 0
                      ? group.members.map((member) => member.name).join(", ")
                      : "아직 아무도 없어요"}
                  </span>
                </span>
                <span className="todo-group-count">
                  {group.members.length}명
                </span>
                <svg
                  className="todo-group-chevron"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </button>
            </li>
          ),
        )}
      </ul>
    </section>
  );
}

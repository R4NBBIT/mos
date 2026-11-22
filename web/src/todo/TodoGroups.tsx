// 친구 그룹(친구 화면 안): 만들기, 이름 바꾸기, 친구 넣고 빼기, 지우기(확인). 일부 공개에서 그룹째 고를 수 있다
import { useCallback, useEffect, useState } from "react";
import { createGroup, deleteGroup, fetchGroups, type TodoGroup, type TodoPerson, todoErrorText, updateGroup } from "./todoApi";

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
  const [members, setMembers] = useState<string[]>(group?.members.map((m) => m.id) ?? []);
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
        placeholder="그룹 이름(예: 회사)"
        value={name}
        maxLength={20}
        onChange={(event) => setName(event.target.value)}
      />
      <div className="todo-audience-group">
        {friends.length === 0 && <span className="todo-setting-help">친구가 없어요.</span>}
        {friends.map((person) => (
          <label key={person.id} className="todo-audience-item">
            <input
              type="checkbox"
              checked={members.includes(person.id)}
              onChange={() =>
                setMembers((current) =>
                  current.includes(person.id) ? current.filter((id) => id !== person.id) : [...current, person.id],
                )
              }
            />
            <span>{person.name}</span>
          </label>
        ))}
      </div>
      {error && <p className="todo-error">{error}</p>}
      <div className="todo-edit-actions">
        <button type="button" className="todo-small-button todo-primary" disabled={!name.trim()} onClick={() => void save()}>
          저장
        </button>
        <button type="button" className="todo-small-button" onClick={onCancel}>
          취소
        </button>
        <span className="todo-spacer" />
        {group && (
          <button type="button" className="todo-small-button todo-danger-text" onClick={() => setConfirming(true)}>
            지우기
          </button>
        )}
      </div>
      {confirming && group && (
        <div className="todo-confirm" role="alertdialog" aria-label="그룹 지우기 확인">
          <span>'{group.name}' 그룹을 지울까요? 이 그룹으로 일부 공개한 카테고리는 그룹 사람들이 못 보게 돼요.</span>
          <div className="todo-confirm-buttons">
            <button type="button" className="todo-small-button" onClick={() => setConfirming(false)}>
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
              지우기
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
      <h2 className="todo-friend-title">그룹</h2>
      <p className="todo-setting-help">카테고리를 '일부'로 공개할 때 그룹째 고를 수 있어요.</p>
      <ul>
        {(groups ?? []).map((group) =>
          editing === group.id ? (
            <li key={group.id}>
              <GroupEditor friends={friends} group={group} onDone={done} onCancel={() => setEditing(null)} />
            </li>
          ) : (
            <li key={group.id} className="todo-friend-row">
              <span className="todo-friend-name">
                <strong>{group.name}</strong>
                <span className="todo-audience-note">
                  {group.members.length > 0 ? group.members.map((member) => member.name).join(", ") : "아직 아무도 없어요"}
                </span>
              </span>
              <span className="todo-friend-actions">
                <button type="button" className="todo-small-button" onClick={() => setEditing(group.id)}>
                  고치기
                </button>
              </span>
            </li>
          ),
        )}
      </ul>
      {editing === "new" ? (
        <GroupEditor friends={friends} group={null} onDone={done} onCancel={() => setEditing(null)} />
      ) : (
        <button type="button" className="todo-small-button" onClick={() => setEditing("new")}>
          새 그룹
        </button>
      )}
    </section>
  );
}

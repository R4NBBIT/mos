// 카테고리 '일부 공개' 대상 고르기: 친구 그룹과 친구를 섞어서. 고른 그룹에 이미 든 친구는
// 따로 고를 수 없고 '○○ 그룹으로 포함됨'으로 보인다(그룹을 나중에 고르면 따로 고른 것은 풀린다)
import { useEffect, useMemo, useState } from "react";
import { fetchGroups, fetchPeople, type TodoAudience, type TodoGroup, type TodoPerson } from "./todoApi";

export function AudiencePicker({
  value,
  onChange,
}: {
  value: TodoAudience;
  onChange: (value: TodoAudience) => void;
}) {
  const [groups, setGroups] = useState<TodoGroup[] | null>(null);
  const [friends, setFriends] = useState<TodoPerson[]>([]);
  useEffect(() => {
    Promise.all([fetchGroups(), fetchPeople()])
      .then(([groupList, people]) => {
        setGroups(groupList);
        setFriends(people.friends);
      })
      .catch(() => setGroups([]));
  }, []);
  // 친구 → 그 친구를 포함한, 고른 그룹 이름들
  const coveredBy = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const group of groups ?? []) {
      if (!value.groups.includes(group.id)) continue;
      for (const member of group.members) map.set(member.id, [...(map.get(member.id) ?? []), group.name]);
    }
    return map;
  }, [groups, value.groups]);

  const toggleGroup = (group: TodoGroup) => {
    const on = !value.groups.includes(group.id);
    const nextGroups = on ? [...value.groups, group.id] : value.groups.filter((id) => id !== group.id);
    // 그룹으로 들어오게 된 친구는 따로 고른 것을 푼다(중복 없이)
    const memberIds = new Set(group.members.map((member) => member.id));
    const nextFriends = on ? value.friends.filter((id) => !memberIds.has(id)) : value.friends;
    onChange({ groups: nextGroups, friends: nextFriends });
  };
  const toggleFriend = (person: TodoPerson) => {
    const on = !value.friends.includes(person.id);
    onChange({ ...value, friends: on ? [...value.friends, person.id] : value.friends.filter((id) => id !== person.id) });
  };

  if (groups === null) return <p className="todo-setting-help">불러오는 중…</p>;
  const total = new Set([...value.friends, ...coveredBy.keys()]).size;
  return (
    <div className="todo-audience">
      <p className="todo-setting-help">고른 친구 {total}명이 볼 수 있어요.</p>
      <div className="todo-audience-group">
        <span className="todo-audience-title">그룹</span>
        {groups.length === 0 && <span className="todo-setting-help">그룹이 없어요. 친구 화면에서 만들 수 있어요.</span>}
        {groups.map((group) => (
          <label key={group.id} className="todo-audience-item">
            <input type="checkbox" checked={value.groups.includes(group.id)} onChange={() => toggleGroup(group)} />
            <span>{group.name}</span>
            <span className="todo-audience-note">{group.members.length}명</span>
          </label>
        ))}
      </div>
      <div className="todo-audience-group">
        <span className="todo-audience-title">친구</span>
        {friends.length === 0 && <span className="todo-setting-help">친구가 없어요.</span>}
        {friends.map((person) => {
          const via = coveredBy.get(person.id);
          return (
            <label key={person.id} className={via ? "todo-audience-item todo-audience-covered" : "todo-audience-item"}>
              <input
                type="checkbox"
                checked={Boolean(via) || value.friends.includes(person.id)}
                disabled={Boolean(via)}
                onChange={() => toggleFriend(person)}
              />
              <span>{person.name}</span>
              {via && <span className="todo-audience-note">{via.map((name) => `'${name}'`).join(", ")} 그룹으로 포함됨</span>}
            </label>
          );
        })}
      </div>
    </div>
  );
}

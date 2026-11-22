-- 친구 그룹과 카테고리 일부 공개(2026-11-22 사용자 요청)
-- 카테고리 공개 범위 'selected' = 고른 친구와 고른 그룹의 친구만
CREATE TABLE todo_friend_group (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (account_id, name)
);

CREATE TABLE todo_friend_group_member (
    group_id INTEGER NOT NULL REFERENCES todo_friend_group (id) ON DELETE CASCADE,
    member_account INTEGER NOT NULL,
    PRIMARY KEY (group_id, member_account)
);

CREATE TABLE todo_category_audience (
    category_id INTEGER NOT NULL REFERENCES todo_category (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('friend', 'group')),
    target INTEGER NOT NULL,
    PRIMARY KEY (category_id, kind, target)
);

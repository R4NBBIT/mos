-- 할 일 기능(공개 전, 기능 스위치 TODO_USERS). 계정은 ㅁㅇㅅ 계정(account.id)
CREATE TABLE todo_category (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'friends',
    memo_shared INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL,
    closed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX todo_category_account ON todo_category (account_id, position);

-- day는 사용자 시간대 기준 날짜 글자(YYYY-MM-DD), time은 HH:MM
CREATE TABLE todo_item (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL,
    category_id INTEGER NOT NULL REFERENCES todo_category (id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    memo TEXT NOT NULL DEFAULT '',
    day TEXT NOT NULL,
    time TEXT,
    place TEXT,
    visibility TEXT,
    position INTEGER NOT NULL,
    done_at INTEGER,
    source TEXT NOT NULL DEFAULT 'app',
    source_client TEXT,
    batch_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX todo_item_day ON todo_item (account_id, day);
CREATE INDEX todo_item_category ON todo_item (category_id);

-- 할 일 반복(REP)과 할 일 설정. 반복은 규칙 하나만 두고, 그날 것을 바꿀 때만 todo_item 행을 만든다
CREATE TABLE todo_repeat (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL,
    category_id INTEGER NOT NULL REFERENCES todo_category (id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    memo TEXT NOT NULL DEFAULT '',
    time TEXT,
    place TEXT,
    rule TEXT NOT NULL,
    weekdays INTEGER NOT NULL DEFAULT 0,
    start_day TEXT NOT NULL,
    end_day TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX todo_repeat_account ON todo_repeat (account_id);

ALTER TABLE todo_item ADD COLUMN repeat_id INTEGER REFERENCES todo_repeat (id) ON DELETE SET NULL;
ALTER TABLE todo_item ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX todo_item_repeat_day ON todo_item (repeat_id, day) WHERE repeat_id IS NOT NULL;

-- 계정마다 할 일 설정(최근에 고른 색 등). 공개 전 기능이라 ㅁㅇㅅ 설정 표와 따로 둔다
CREATE TABLE todo_pref (
    account_id INTEGER PRIMARY KEY,
    prefs_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

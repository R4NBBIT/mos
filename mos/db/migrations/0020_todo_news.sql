-- 할 일 소식(NOTI-06): 보낸 알림을 소식 목록에 남겨 안 읽음 점을 보인다. 계정당 최근 50개, 30일
CREATE TABLE todo_news (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX todo_news_account ON todo_news (account_id, id);

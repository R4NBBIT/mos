-- 할 일 AI 연결: 조심해야 하는 일(지우기, 카테고리 만들기/바꾸기/끝내기, 공개 범위)
-- 1) AI가 먼저 요청만 만들고(확인 번호), 사용자가 대화에서 '네'라고 한 뒤 confirm_action으로 실행
-- 2) 공개 범위를 넓히거나 메모 공개를 켜는 것은 ㅁㅇㅅ 화면에서 승인해야 적용(state = 'app')
CREATE TABLE todo_ai_action (
    id TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL,
    grant_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    summary TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE INDEX todo_ai_action_account ON todo_ai_action (account_id, state);

-- AI가 지운 할 일(7일 동안 되돌리기). kind: item(행을 지움, payload에 원래 값), skip(반복 회차를 건너뜀)
CREATE TABLE todo_trash (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    item_id INTEGER,
    payload TEXT NOT NULL,
    label TEXT NOT NULL,
    day TEXT NOT NULL,
    client_name TEXT NOT NULL,
    deleted_at INTEGER NOT NULL
);

CREATE INDEX todo_trash_account ON todo_trash (account_id, deleted_at);

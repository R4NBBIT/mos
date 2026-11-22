-- 할 일 친구 차단(2026-11-22 사용자 요청: 요청 횟수 제한 대신 차단)
-- 한쪽이라도 차단하면 서로 할 일이 안 보이고, 요청과 반응도 못 하고, 친구 추가 목록에도 안 나온다
CREATE TABLE todo_block (
    account_id INTEGER NOT NULL,
    blocked_account INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, blocked_account)
);

CREATE INDEX todo_block_blocked ON todo_block (blocked_account);

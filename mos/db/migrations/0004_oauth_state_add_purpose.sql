-- '다른 계정 추가'(add) 목적을 따로 구분한다. oauth_state는 10분짜리 임시 값이라 새로 만든다.
DROP TABLE oauth_state;

CREATE TABLE oauth_state (
    state_hash TEXT PRIMARY KEY,
    device_id INTEGER NOT NULL REFERENCES device (id) ON DELETE CASCADE,
    code_verifier TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('connect', 'add', 'reset')),
    expires_at INTEGER NOT NULL
);

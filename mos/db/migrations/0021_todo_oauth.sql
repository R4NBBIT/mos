-- 할 일 AI 연결(T3): 각자의 Claude, ChatGPT가 MCP 커넥터로 붙는다. OAuth 2.1(+PKCE, 동적 등록)
-- 토큰과 코드는 해시만 저장한다

-- 동적 등록한 앱(커넥터). 누구나 등록할 수 있어 승인 전에는 아무 권한도 없다
CREATE TABLE oauth_client (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- 승인 화면을 기다리는 요청(10분)
CREATE TABLE oauth_request (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_client (id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    state TEXT,
    code_challenge TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- 사용자가 승인한 연결(설정에서 보이고 끊을 수 있다)
CREATE TABLE oauth_grant (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL,
    client_id TEXT NOT NULL REFERENCES oauth_client (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
);

CREATE INDEX oauth_grant_account ON oauth_grant (account_id);

-- 한 번 쓰는 승인 코드(5분)
CREATE TABLE oauth_code (
    code_hash TEXT PRIMARY KEY,
    grant_id INTEGER NOT NULL REFERENCES oauth_grant (id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
);

-- 접근 토큰(1시간), 새로 고침 토큰(30일, 쓸 때마다 새것으로)
CREATE TABLE oauth_token (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    grant_id INTEGER NOT NULL REFERENCES oauth_grant (id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX oauth_token_grant ON oauth_token (grant_id);

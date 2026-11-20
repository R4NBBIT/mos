-- 3단계 계정·기기. 시간은 모두 유닉스 초(INTEGER)로 저장한다.

-- 앱 계정(디스코드 사용자 1명). OAuth 토큰은 AES-GCM으로 암호화해 저장한다.
CREATE TABLE account (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_user_id INTEGER NOT NULL UNIQUE,
    name TEXT NOT NULL,
    avatar_url TEXT,
    password_hash TEXT,
    oauth_access_enc TEXT,
    oauth_refresh_enc TEXT,
    token_expires_at INTEGER,
    premium_type INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disconnected')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 계정이 들어가 있는 디스코드 서버(로그인할 때 받아 둔다. 봇이 있는 서버와 겹치는 것만)
CREATE TABLE account_guild (
    account_id INTEGER NOT NULL REFERENCES account (id) ON DELETE CASCADE,
    guild_id INTEGER NOT NULL,
    PRIMARY KEY (account_id, guild_id)
);

-- 브라우저 1개. 쿠키에는 원문 토큰, DB에는 SHA-256 해시만.
CREATE TABLE device (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    active_account_id INTEGER REFERENCES account (id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
);

-- 브라우저에 저장된 계정(최대 5)과 잠금 상태.
CREATE TABLE device_account (
    device_id INTEGER NOT NULL REFERENCES device (id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES account (id) ON DELETE CASCADE,
    added_at INTEGER NOT NULL,
    unlocked_until INTEGER,
    keep_until INTEGER,
    password_setup_until INTEGER,
    last_view_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (device_id, account_id)
);

CREATE INDEX device_account_account ON device_account (account_id);

-- 비밀번호 5회 실패 제한(계정 단위)
CREATE TABLE login_attempt (
    account_id INTEGER PRIMARY KEY REFERENCES account (id) ON DELETE CASCADE,
    fail_count INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER
);

-- OAuth 요청 위조 방지. state는 해시로만 저장, 한 번 쓰면 삭제, 10분 후 만료.
CREATE TABLE oauth_state (
    state_hash TEXT PRIMARY KEY,
    device_id INTEGER NOT NULL REFERENCES device (id) ON DELETE CASCADE,
    code_verifier TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('connect', 'reset')),
    expires_at INTEGER NOT NULL
);

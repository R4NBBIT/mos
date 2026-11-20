-- 4단계: 고정, 안 읽음, 월 송신량

-- 고정(모임 최대 5, 채널 최대 10). position이 작을수록 위
CREATE TABLE pin (
    account_id INTEGER NOT NULL REFERENCES account (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('group', 'channel')),
    target_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (account_id, kind, target_id)
);

-- 계정·채널별 마지막으로 읽은 메시지. 처음 보는 채널은 줄이 없고 '안 읽음 0'으로 본다
CREATE TABLE read_state (
    account_id INTEGER NOT NULL REFERENCES account (id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL,
    last_read_id INTEGER NOT NULL,
    PRIMARY KEY (account_id, channel_id)
);

-- 월 송신량(구글 무료 1GB 보호). month = 'YYYY-MM'(UTC)
CREATE TABLE egress_month (
    month TEXT PRIMARY KEY,
    bytes_out INTEGER NOT NULL DEFAULT 0,
    alerted_80 INTEGER NOT NULL DEFAULT 0
);

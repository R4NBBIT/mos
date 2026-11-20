-- 3-3 보내기. 채널(스레드면 부모 채널)마다 앱 웹훅 하나. 웹훅 토큰은 AES-GCM으로 암호화한다.
CREATE TABLE channel_webhook (
    channel_id INTEGER PRIMARY KEY,
    webhook_id INTEGER NOT NULL,
    webhook_token_enc TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- 웹에서 누가 보냈는지(본인만 수정·삭제), 답장 대상, 같은 요청 두 번 보내기 방지
CREATE TABLE web_sent (
    message_id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES account (id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL,
    reply_to_id INTEGER,
    idempotency_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (account_id, idempotency_key)
);

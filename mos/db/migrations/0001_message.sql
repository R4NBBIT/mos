-- 메시지 캐시(디스코드 원본의 사본). 90일 보관은 이후 정리 작업에서.
-- 디스코드 ID(snowflake)는 2^63보다 작아 SQLite INTEGER에 그대로 들어간다.
CREATE TABLE message (
    id INTEGER PRIMARY KEY,
    guild_id INTEGER,
    channel_id INTEGER NOT NULL,
    author_id INTEGER NOT NULL,
    author_name TEXT NOT NULL,
    author_avatar TEXT,
    author_is_bot INTEGER NOT NULL DEFAULT 0,
    webhook_id INTEGER,
    content TEXT NOT NULL DEFAULT '',
    embeds_json TEXT NOT NULL DEFAULT '[]',
    attachments_json TEXT NOT NULL DEFAULT '[]',
    components_json TEXT NOT NULL DEFAULT '[]',
    reference_id INTEGER,
    flags INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    edited_at TEXT
);

CREATE INDEX message_channel_id ON message (channel_id, id);

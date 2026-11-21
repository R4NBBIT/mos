-- 반응(이모지 반응). message.reactions_json: 디스코드에 달린 반응 종류별 수와 봇이 달았는지
-- [{"key", "id", "name", "animated", "count", "bot"}]. key는 사용자 이모지면 ID, 기본 이모지면 그 글자.
ALTER TABLE message ADD COLUMN reactions_json TEXT NOT NULL DEFAULT '[]';

-- 누가 달았는지 아는 경우만: 봇이 이벤트로 본 디스코드 사용자(via='discord'),
-- ㅁㅇㅅ 웹에서 누른 사람(via='web', 디스코드에는 봇 이름으로 하나만 달린다)
CREATE TABLE reaction_user (
    message_id INTEGER NOT NULL,
    emoji_key TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    via TEXT NOT NULL CHECK (via IN ('discord', 'web')),
    PRIMARY KEY (message_id, emoji_key, user_id, via)
);

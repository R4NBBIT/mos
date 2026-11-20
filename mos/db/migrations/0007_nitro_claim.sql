-- 니트로 확인. 디스코드는 일반 앱에 니트로 여부(premium_type)를 항상 0으로 준다.
-- 그래서 '니트로 있어요'라고 켠 계정만, 디스코드 앱에서 니트로 전용 이모지를 직접 쓴 것을 보고
-- 7일 동안 확인된 것으로 둔다.
ALTER TABLE account ADD COLUMN nitro_claimed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE account ADD COLUMN nitro_verified_until INTEGER;

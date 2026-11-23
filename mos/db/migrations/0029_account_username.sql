-- 디스코드 아이디(사용자명, 소문자). TODO 친구 추가는 닉네임이 아니라 이 아이디로만 찾는다(2026-11-23 사용자 요청).
-- 로그인할 때 저장하고, 예전 계정은 처음 찾을 때 봇이 서버 멤버 정보에서 채운다.
ALTER TABLE account ADD COLUMN username TEXT;
CREATE INDEX idx_account_username ON account (username);

-- 본문 속 <@사람> <@&역할> <#채널> 코드를 이름으로 보여 주기 위해, 받을 때의 이름을 함께 저장한다.
-- 모양: {"users": {"ID": "이름"}, "roles": {"ID": "이름"}, "channels": {"ID": "이름"}}
ALTER TABLE message ADD COLUMN mentions_json TEXT NOT NULL DEFAULT '{}';

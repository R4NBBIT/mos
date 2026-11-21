-- 디스코드 스티커(id·이름·형식). 본문 없이 스티커만 보낸 메시지도 웹에 보이게
ALTER TABLE message ADD COLUMN stickers_json TEXT NOT NULL DEFAULT '[]';

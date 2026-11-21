-- 디스코드 메시지 종류(0 보통, 19 답장, 7 입장, 6 고정 알림, 8~11 부스트 등).
-- 시스템 메시지는 본문이 비어 있어 화면에서 따로 보여 준다. 예전 행은 0으로 남는다.
ALTER TABLE message ADD COLUMN kind INTEGER NOT NULL DEFAULT 0;

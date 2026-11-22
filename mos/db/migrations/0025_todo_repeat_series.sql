-- 반복 화면(2026-11-22 사용자 요청)
-- skip_holidays: 한국 공휴일(대체 휴일 포함)에는 회차를 만들지 않음
-- series_id: 같은 반복의 여러 기간. 끝난 반복을 새 기간으로 다시 쓰면 같은 series_id의 행이 하나 더 생긴다
-- (NULL이면 자기 id가 series)
ALTER TABLE todo_repeat ADD COLUMN skip_holidays INTEGER NOT NULL DEFAULT 0;
ALTER TABLE todo_repeat ADD COLUMN series_id INTEGER;

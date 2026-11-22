-- 점메추(R4NBOT에서 가져옴, 2026-11-22 사용자 요청)
-- 공통 메뉴는 mos/data/menu.txt. 여기에는 바뀐 것만:
--   scope = 0: 공통 메뉴에 더한 것(운영자만), scope = 서버 ID: 그 서버에서 더한 것(added) 또는 숨긴 공통 메뉴(removed)
CREATE TABLE menu_override (
    scope INTEGER NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('added', 'removed')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (scope, name)
);

-- 웹 푸시: 탭을 닫아도 알림. 브라우저(기기)·계정마다 구독 하나씩.
CREATE TABLE push_sub (
    endpoint TEXT PRIMARY KEY,
    device_id INTEGER NOT NULL,
    account_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX push_sub_account ON push_sub (account_id);

-- 서버가 처음 켜질 때 만드는 열쇠 등(값은 암호화). 지금은 웹 푸시 VAPID 비밀 열쇠 하나
CREATE TABLE app_secret (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

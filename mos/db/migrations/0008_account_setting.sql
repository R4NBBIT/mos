-- 5-2 계정별 설정(테마, 탭 제목 등). 값은 JSON 한 덩어리, 서버가 키·값을 검사한 뒤 저장한다.
CREATE TABLE account_setting (
    account_id INTEGER PRIMARY KEY REFERENCES account (id) ON DELETE CASCADE,
    settings_json TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
);

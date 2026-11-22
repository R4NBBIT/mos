-- 기기(브라우저, 설치한 앱)마다 따로 정하는 설정. 없는 항목은 계정 설정(예전 값)을 쓴다
CREATE TABLE device_setting (
    device_id INTEGER NOT NULL,
    account_id INTEGER NOT NULL,
    settings_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (device_id, account_id)
);

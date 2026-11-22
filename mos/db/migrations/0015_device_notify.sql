-- 알림 설정은 기기(브라우저)마다 따로: 회사 컴퓨터는 끄고 휴대폰만 켜는 식으로.
-- 한 기기에 계정이 여럿이면 계정마다 따로. 값은 정해진 키만(services/notify_prefs.py가 검사).
CREATE TABLE device_notify (
    device_id INTEGER NOT NULL,
    account_id INTEGER NOT NULL,
    prefs_json TEXT NOT NULL,
    PRIMARY KEY (device_id, account_id)
);

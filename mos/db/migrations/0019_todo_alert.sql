-- 할 일 알림(NOTI-01, NOTI-03): 이미 보낸 알림. 서버가 다시 켜져도 두 번 보내지 않게
CREATE TABLE todo_alert_sent (
    account_id INTEGER NOT NULL,
    alert_key TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, alert_key)
);

CREATE INDEX todo_alert_sent_time ON todo_alert_sent (sent_at);

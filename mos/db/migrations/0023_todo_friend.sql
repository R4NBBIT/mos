-- 할 일 친구(T4, FRIEND/VIS/REACT). 같은 디스코드 서버(봇이 있는 서버)의 할 일 사용자끼리만
-- 한 쌍에 한 줄(account_a < account_b), requester가 요청한 사람
CREATE TABLE todo_friend (
    account_a INTEGER NOT NULL,
    account_b INTEGER NOT NULL,
    requester INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
    created_at INTEGER NOT NULL,
    accepted_at INTEGER,
    PRIMARY KEY (account_a, account_b),
    CHECK (account_a < account_b)
);

CREATE INDEX todo_friend_b ON todo_friend (account_b);

-- 할 일 반응: 유니코드 이모지 또는 디스코드 이모지 코드(<a:이름:ID>). 한 사람이 한 이모지는 한 번
CREATE TABLE todo_reaction (
    item_id INTEGER NOT NULL REFERENCES todo_item (id) ON DELETE CASCADE,
    owner_account INTEGER NOT NULL,
    reactor_account INTEGER NOT NULL,
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (item_id, reactor_account, emoji)
);

CREATE INDEX todo_reaction_owner ON todo_reaction (owner_account);

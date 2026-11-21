-- 위장 화면에 노션(note), Word(word) 글도 올릴 수 있게 boss_asset의 kind 제한을 넓힌다.
-- SQLite는 CHECK를 바꿀 수 없어 같은 모양의 새 표로 옮긴다(내용, 암호화는 그대로).
CREATE TABLE boss_asset_new (
    account_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('sheet', 'image', 'text', 'note', 'word')),
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    data BLOB NOT NULL,
    size INTEGER NOT NULL,
    version TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, kind)
);
INSERT INTO boss_asset_new (account_id, kind, name, mime, data, size, version, updated_at)
    SELECT account_id, kind, name, mime, data, size, version, updated_at FROM boss_asset;
DROP TABLE boss_asset;
ALTER TABLE boss_asset_new RENAME TO boss_asset;

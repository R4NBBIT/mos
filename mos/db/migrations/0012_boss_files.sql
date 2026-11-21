-- 위장 화면 파일을 계정에 저장(다른 브라우저·PC에서도 그대로). 내용은 AES-GCM으로 암호화해 둔다.
-- kind: sheet(불러온 표를 읽은 결과 JSON), image(스크린샷), text(글 문서 원본)
CREATE TABLE boss_asset (
    account_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('sheet', 'image', 'text')),
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    data BLOB NOT NULL,
    size INTEGER NOT NULL,
    version TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, kind)
);

-- 위장 표에 고친 내용, 글 문서에 쓴 내용(표·파일마다 열쇠가 다르다)
CREATE TABLE boss_edit (
    account_id INTEGER NOT NULL,
    edit_key TEXT NOT NULL,
    edits_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, edit_key)
);

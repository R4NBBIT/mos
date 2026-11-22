-- 같은 앱(이름과 돌아갈 주소가 같음)을 여러 번 연결해 겹친 연결은 가장 최근 것만 남긴다.
UPDATE oauth_grant
SET revoked_at = CAST(strftime('%s', 'now') AS INTEGER)
WHERE revoked_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM oauth_grant newer
    JOIN oauth_client newer_client ON newer_client.id = newer.client_id
    JOIN oauth_client this_client ON this_client.id = oauth_grant.client_id
    WHERE newer.account_id = oauth_grant.account_id
      AND newer.revoked_at IS NULL
      AND newer.id > oauth_grant.id
      AND newer_client.name = this_client.name
      AND newer_client.redirect_uris = this_client.redirect_uris
  );

DELETE FROM oauth_token
WHERE grant_id IN (SELECT id FROM oauth_grant WHERE revoked_at IS NOT NULL);

DELETE FROM oauth_code
WHERE grant_id IN (SELECT id FROM oauth_grant WHERE revoked_at IS NOT NULL);

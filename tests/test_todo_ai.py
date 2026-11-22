"""할 일 AI 연결(T3): OAuth 2.1(동적 등록, PKCE), MCP 도구, 연결 끊기, 공개 전 숨김."""

from __future__ import annotations

import base64
import hashlib
from collections.abc import Iterator
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

from tests.test_api import ORIGIN, POST, Env, signed_up
from tests.test_todo import build

VERIFIER = "v" * 50
CHALLENGE = (
    base64.urlsafe_b64encode(hashlib.sha256(VERIFIER.encode()).digest()).rstrip(b"=").decode()
)
REDIRECT = "https://claude.ai/api/mcp/auth_callback"


@pytest.fixture
def env(tmp_path: Path) -> Iterator[Env]:
    yield from build(tmp_path, frozenset({42}))


def register(env: Env) -> str:
    response = env.client.post(
        "/oauth/register", json={"client_name": "Claude", "redirect_uris": [REDIRECT]}
    )
    assert response.status_code == 201
    return response.json()["client_id"]


def authorize(env: Env, client_id: str, **extra: str) -> str:
    params = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": REDIRECT,
        "code_challenge": CHALLENGE,
        "code_challenge_method": "S256",
        "state": "abc",
        "scope": "todo",
        "resource": ORIGIN + "/mcp",
        **extra,
    }
    response = env.client.get("/oauth/authorize", params=params, follow_redirects=False)
    assert response.status_code == 302, response.text
    location = response.headers["location"]
    assert location.startswith("/#/connect/")
    return location.rsplit("/", 1)[1]


def approve(env: Env, request_id: str, allow: bool = True) -> dict[str, list[str]]:
    response = env.client.post(
        f"/api/todo/oauth/request/{request_id}", json={"allow": allow}, headers=POST
    )
    assert response.status_code == 200, response.text
    target = urlsplit(response.json()["redirect"])
    assert f"{target.scheme}://{target.netloc}{target.path}" == REDIRECT
    return parse_qs(target.query)


def tokens(env: Env, code: str, client_id: str) -> dict:
    response = env.client.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "code_verifier": VERIFIER,
            "client_id": client_id,
            "redirect_uri": REDIRECT,
        },
    )
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    return response.json()


def connect(env: Env) -> tuple[str, dict]:
    signed_up(env, "mocha")
    client_id = register(env)
    query = approve(env, authorize(env, client_id))
    assert query["state"] == ["abc"]
    return client_id, tokens(env, query["code"][0], client_id)


def rpc(env: Env, token: str, method: str, params: dict | None = None, msg_id: int = 1):
    body = {"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params or {}}
    return env.client.post("/mcp", json=body, headers={"Authorization": f"Bearer {token}"})


def call(env: Env, token: str, name: str, arguments: dict | None = None) -> dict:
    response = rpc(env, token, "tools/call", {"name": name, "arguments": arguments or {}})
    assert response.status_code == 200, response.text
    return response.json()["result"]


def test_metadata_and_unauthorized(env: Env) -> None:
    meta = env.client.get("/.well-known/oauth-authorization-server").json()
    assert meta["code_challenge_methods_supported"] == ["S256"]
    assert meta["registration_endpoint"] == ORIGIN + "/oauth/register"
    res = env.client.get("/.well-known/oauth-protected-resource").json()
    assert res["resource"] == ORIGIN + "/mcp"
    response = env.client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert response.status_code == 401
    assert "resource_metadata=" in response.headers["www-authenticate"]
    assert env.client.options("/mcp").status_code == 204


def test_full_flow_and_tools(env: Env) -> None:
    client_id, issued = connect(env)
    token = issued["access_token"]
    init = rpc(env, token, "initialize", {"protocolVersion": "2025-06-18"}).json()["result"]
    assert init["protocolVersion"] == "2025-06-18"
    assert "오전/오후" in init["instructions"]
    note = env.client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "method": "notifications/initialized"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert note.status_code == 202
    names = [tool["name"] for tool in rpc(env, token, "tools/list").json()["result"]["tools"]]
    assert names == [
        "list_categories",
        "list_todos",
        "add_todos",
        "update_todo",
        "complete_todo",
        "undo_last_add",
    ]
    cats = call(env, token, "list_categories")
    assert cats["structuredContent"]["categories"] == ["할 일"]
    added = call(
        env,
        token,
        "add_todos",
        {
            "items": [
                {"title": "치과", "day": "2026-11-23", "time": "15:00", "place": "강남역"},
                {"title": "장보기", "day": "2026-11-23", "category": "[할 일]"},
            ]
        },
    )
    assert "11월 23일 (월)" in added["content"][0]["text"]
    assert "- 15:00 치과 @강남역 [할 일]" in added["content"][0]["text"]
    first_id = added["structuredContent"]["added"][0]["id"]
    # 앱에서도 보이고 AI가 넣었다고 표시
    items = env.client.get("/api/todo/day/2026-11-23").json()["items"]
    assert {item["source"] for item in items} == {"ai"}
    done = call(env, token, "complete_todo", {"id": first_id})
    assert done["structuredContent"]["todo"]["done"] is True
    fixed = call(env, token, "update_todo", {"id": first_id, "time": None, "place": None})
    assert fixed["structuredContent"]["todo"]["time"] is None
    listed = call(env, token, "list_todos", {"start_day": "2026-11-23"})
    assert len(listed["structuredContent"]["todos"]) == 2
    bad = call(
        env,
        token,
        "add_todos",
        {"items": [{"title": "x", "day": "2026-11-23", "category": "없음"}]},
    )
    assert bad["isError"] is True and "할 일" in bad["content"][0]["text"]
    undone = call(env, token, "undo_last_add")
    assert undone["structuredContent"]["removed"] == 2
    assert env.client.get("/api/todo/day/2026-11-23").json()["items"] == []
    again = call(env, token, "undo_last_add")
    assert again["isError"] is True or again["structuredContent"]["removed"] == 0
    assert client_id


def test_refresh_rotation_and_reuse(env: Env) -> None:
    client_id, issued = connect(env)
    first = env.client.post(
        "/oauth/token",
        data={"grant_type": "refresh_token", "refresh_token": issued["refresh_token"]},
    )
    assert first.status_code == 200
    new = first.json()
    assert rpc(env, new["access_token"], "ping").status_code == 200
    # 이미 쓴 새로 고침 토큰을 다시 쓰면 연결을 끊는다
    reuse = env.client.post(
        "/oauth/token",
        data={"grant_type": "refresh_token", "refresh_token": issued["refresh_token"]},
    )
    assert reuse.status_code == 400 and reuse.json()["error"] == "invalid_grant"
    assert rpc(env, new["access_token"], "ping").status_code == 401
    assert client_id


def test_code_checks(env: Env) -> None:
    signed_up(env, "mocha")
    client_id = register(env)
    code = approve(env, authorize(env, client_id))["code"][0]
    wrong = env.client.post(
        "/oauth/token",
        data={"grant_type": "authorization_code", "code": code, "code_verifier": "w" * 50},
    )
    assert wrong.status_code == 400
    # 한 번 쓴(틀린 검증값이라도) 코드는 다시 못 씀
    retry = env.client.post(
        "/oauth/token",
        data={"grant_type": "authorization_code", "code": code, "code_verifier": VERIFIER},
    )
    assert retry.status_code == 400
    denied = approve(env, authorize(env, client_id), allow=False)
    assert denied["error"] == ["access_denied"] and "code" not in denied


def test_authorize_rejects_bad_requests(env: Env) -> None:
    client_id = register(env)
    for extra in (
        {"redirect_uri": "https://evil.example/cb"},
        {"code_challenge_method": "plain"},
        {"scope": "messages"},
        {"resource": "https://other.example/mcp"},
    ):
        params = {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": REDIRECT,
            "code_challenge": CHALLENGE,
            "code_challenge_method": "S256",
            **extra,
        }
        response = env.client.get("/oauth/authorize", params=params, follow_redirects=False)
        assert response.status_code == 400, extra
    bad = env.client.post("/oauth/register", json={"redirect_uris": ["http://evil.example/cb"]})
    assert bad.status_code == 400


def test_not_allowed_account_cannot_approve(env: Env) -> None:
    signed_up(env, "latte")  # 허용 목록에 없음
    client_id = register(env)
    request_id = authorize(env, client_id)
    assert env.client.get(f"/api/todo/oauth/request/{request_id}").status_code == 404
    response = env.client.post(
        f"/api/todo/oauth/request/{request_id}", json={"allow": True}, headers=POST
    )
    assert response.status_code == 404


def test_disconnect(env: Env) -> None:
    _client_id, issued = connect(env)
    listed = env.client.get("/api/todo/connections").json()
    assert listed["mcp_url"] == ORIGIN + "/mcp"
    assert [c["name"] for c in listed["connections"]] == ["Claude"]
    grant_id = listed["connections"][0]["id"]
    assert env.client.delete(f"/api/todo/connections/{grant_id}", headers=POST).status_code == 204
    assert env.client.get("/api/todo/connections").json()["connections"] == []
    assert rpc(env, issued["access_token"], "ping").status_code == 401

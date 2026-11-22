"""TODO AI 연결(T3): OAuth 2.1(동적 등록, PKCE), MCP 도구, 연결 끊기, 공개 전 숨김."""

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
        "delete_todos",
        "add_category",
        "update_category",
        "close_category",
        "confirm_action",
        "list_friends",
        "friend_request",
        "friend_accept",
        "friend_remove",
        "create_group",
        "update_group",
        "delete_group",
        "set_category_audience",
        "block_person",
        "unblock_person",
        "list_repeats",
        "create_repeat",
        "add_repeat_period",
        "update_repeat",
        "delete_repeat",
        "end_repeat",
    ]
    cats = call(env, token, "list_categories")
    assert cats["structuredContent"]["categories"] == ["TODO"]
    added = call(
        env,
        token,
        "add_todos",
        {
            "items": [
                {"title": "치과", "day": "2026-11-23", "time": "15:00", "place": "강남역"},
                {"title": "장보기", "day": "2026-11-23", "category": "[TODO]"},
            ]
        },
    )
    assert "11월 23일 (월)" in added["content"][0]["text"]
    assert "- 15:00 치과 @강남역 [TODO]" in added["content"][0]["text"]
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
    assert listed["structuredContent"]["todos"][0]["color"].startswith("#")  # 위젯 체크 색
    bad = call(
        env,
        token,
        "add_todos",
        {"items": [{"title": "x", "day": "2026-11-23", "category": "없음"}]},
    )
    assert bad["isError"] is True and "TODO" in bad["content"][0]["text"]
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


def test_delete_needs_confirm_and_goes_to_trash(env: Env) -> None:
    _client_id, issued = connect(env)
    token = issued["access_token"]
    added = call(
        env,
        token,
        "add_todos",
        {"items": [{"title": "치과", "day": "2026-11-23", "time": "15:00"}]},
    )
    item_id = added["structuredContent"]["added"][0]["id"]
    asked = call(env, token, "delete_todos", {"ids": [item_id]})
    assert "아직 실행하지 않았어요" in asked["content"][0]["text"]
    summary = asked["structuredContent"]["summary"]
    assert "11월 23일 (월)\n[TODO]\n- 15:00 치과" in summary
    # 확인 전에는 그대로
    assert len(env.client.get("/api/todo/day/2026-11-23").json()["items"]) == 1
    bad = call(env, token, "confirm_action", {"confirm_id": "nope-nope"})
    assert bad["isError"] is True
    done = call(
        env, token, "confirm_action", {"confirm_id": asked["structuredContent"]["confirm_id"]}
    )
    assert "휴지통" in done["content"][0]["text"]
    assert env.client.get("/api/todo/day/2026-11-23").json()["items"] == []
    # 같은 확인 번호는 한 번만
    again = call(
        env, token, "confirm_action", {"confirm_id": asked["structuredContent"]["confirm_id"]}
    )
    assert again["isError"] is True
    trash = env.client.get("/api/todo/ai").json()["trash"]
    assert [t["title"] for t in trash] == ["치과"] and trash[0]["client"] == "Claude"
    restored = env.client.post(f"/api/todo/ai/trash/{trash[0]['id']}/restore", headers=POST)
    assert restored.status_code == 204
    items = env.client.get("/api/todo/day/2026-11-23").json()["items"]
    assert [(i["title"], i["time"]) for i in items] == [("치과", "15:00")]
    assert env.client.get("/api/todo/ai").json()["trash"] == []


def test_category_actions_and_widening_needs_app_approval(env: Env) -> None:
    _client_id, issued = connect(env)
    token = issued["access_token"]
    made = call(env, token, "add_category", {"name": "운동", "color": "#16A34A"})
    call(env, token, "confirm_action", {"confirm_id": made["structuredContent"]["confirm_id"]})
    names = call(env, token, "list_categories")["structuredContent"]["categories"]
    assert names == ["TODO", "운동"]
    # 좁히기(친구 → 나만)는 대화 확인만
    narrow = call(env, token, "update_category", {"category": "운동", "visibility": "private"})
    assert "친구 → 나만" in narrow["structuredContent"]["summary"]
    call(env, token, "confirm_action", {"confirm_id": narrow["structuredContent"]["confirm_id"]})
    cats = env.client.get("/api/todo/categories").json()["categories"]
    assert next(c for c in cats if c["name"] == "운동")["visibility"] == "private"
    # 넓히기(나만 → 전체)는 ㅁㅇㅅ 화면 승인까지
    wide = call(env, token, "update_category", {"category": "운동", "visibility": "public"})
    waiting = call(
        env, token, "confirm_action", {"confirm_id": wide["structuredContent"]["confirm_id"]}
    )
    assert "승인해야" in waiting["content"][0]["text"]
    cats = env.client.get("/api/todo/categories").json()["categories"]
    assert next(c for c in cats if c["name"] == "운동")["visibility"] == "private"
    pending = env.client.get("/api/todo/ai").json()["pending"]
    assert len(pending) == 1 and "나만 → 전체" in pending[0]["summary"]
    news = env.client.get("/api/todo/news").json()
    assert news["unread"] == 1 and news["items"][0]["kind"] == "ai_request"
    ok = env.client.post(
        f"/api/todo/ai/pending/{pending[0]['id']}", json={"approve": True}, headers=POST
    )
    assert ok.status_code == 200
    cats = env.client.get("/api/todo/categories").json()["categories"]
    assert next(c for c in cats if c["name"] == "운동")["visibility"] == "public"
    # 끝내기는 지우지 않고 숨김
    close = call(env, token, "close_category", {"category": "운동"})
    call(env, token, "confirm_action", {"confirm_id": close["structuredContent"]["confirm_id"]})
    cats = env.client.get("/api/todo/categories").json()["categories"]
    assert next(c for c in cats if c["name"] == "운동")["closed"] is True


def test_other_connection_cannot_confirm(env: Env) -> None:
    _client_id, issued = connect(env)
    asked = call(env, issued["access_token"], "add_category", {"name": "공부"})
    second_client = register(env)
    query = approve(env, authorize(env, second_client))
    other = tokens(env, query["code"][0], second_client)["access_token"]
    result = call(
        env, other, "confirm_action", {"confirm_id": asked["structuredContent"]["confirm_id"]}
    )
    assert result["isError"] is True


def test_android_app_redirect(env: Env) -> None:
    ok = env.client.post(
        "/oauth/register",
        json={"client_name": "ㅁㅇㅅ 위젯", "redirect_uris": ["com.teamsheetnote.mos.todo:/oauth"]},
    )
    assert ok.status_code == 201
    for bad in ("javascript:/x", "file:/etc/passwd", "com:/x", "data:/x"):
        response = env.client.post("/oauth/register", json={"redirect_uris": [bad]})
        assert response.status_code == 400, bad


def test_app_delete_goes_to_trash(env: Env) -> None:
    signed_up(env, "mocha")
    cat = env.client.get("/api/todo/day/2026-11-23").json()["categories"][0]["id"]
    item = env.client.post(
        "/api/todo/items",
        json={"title": "빨래", "day": "2026-11-23", "category_id": cat},
        headers=POST,
    ).json()["id"]
    env.tick(1)
    assert env.client.delete(f"/api/todo/items/{item}", headers=POST).status_code == 204
    trash = env.client.get("/api/todo/ai").json()["trash"]
    assert [(t["title"], t["client"]) for t in trash] == [("빨래", "")]
    env.client.post(f"/api/todo/ai/trash/{trash[0]['id']}/restore", headers=POST)
    assert [i["title"] for i in env.client.get("/api/todo/day/2026-11-23").json()["items"]] == [
        "빨래"
    ]


def test_ai_friend_actions_need_app_approval(tmp_path: Path) -> None:
    from tests.test_api import POST as _POST
    from tests.test_todo_friends import use

    gen = build(tmp_path, frozenset({42, 43}))
    env = next(gen)
    try:
        latte = signed_up(env, "latte")
        _client_id, issued = connect(env)  # 모카로 연결
        token = issued["access_token"]
        listed = call(env, token, "list_friends")
        assert listed["structuredContent"]["candidates"] == ["라떼"]
        asked = call(env, token, "friend_request", {"person": "라떼"})
        assert "ㅁㅇㅅ 화면에서 한 번 더" in asked["content"][0]["text"]
        waiting = call(
            env, token, "confirm_action", {"confirm_id": asked["structuredContent"]["confirm_id"]}
        )
        assert "승인해야" in waiting["content"][0]["text"]
        # 아직 요청 안 감
        assert env.client.get("/api/todo/people").json()["outgoing"] == []
        pending = env.client.get("/api/todo/ai").json()["pending"]
        assert pending[0]["summary"] == "라떼님에게 친구 요청"
        ok = env.client.post(
            f"/api/todo/ai/pending/{pending[0]['id']}", json={"approve": True}, headers=_POST
        )
        assert ok.json()["message"] == "친구 요청을 보냈어요."
        assert [p["name"] for p in env.client.get("/api/todo/people").json()["outgoing"]] == [
            "라떼"
        ]
        bad = call(env, token, "friend_accept", {"person": "없는사람"})
        assert bad["isError"] is True
        assert latte
        _ = use
    finally:
        gen.close()


def test_every_delete_goes_to_trash(env: Env) -> None:
    """카테고리, 반복 앞으로 것까지 지우기도 휴지통에서 되살린다(2026-11-22 사용자 결정)."""
    signed_up(env, "mocha")
    made = env.client.post(
        "/api/todo/categories", json={"name": "운동", "color": "#16A34A"}, headers=POST
    ).json()
    cat = made["id"]
    item = env.client.post(
        "/api/todo/items",
        json={"title": "달리기", "day": "2026-11-23", "category_id": cat},
        headers=POST,
    ).json()["id"]
    env.client.post(
        "/api/todo/items",
        json={"title": "스트레칭", "day": "2026-11-23", "category_id": cat},
        headers=POST,
    )
    env.client.post("/api/todo/repeats", json={"item_id": item, "rule": "daily"}, headers=POST)
    env.tick(1)
    # 반복 앞으로 것까지 지우기 → 휴지통 → 되살리면 다시 매일
    day = env.client.get("/api/todo/day/2026-11-25").json()
    rid = next(i["id"] for i in day["items"] if i["title"] == "달리기")
    assert env.client.delete(f"/api/todo/items/{rid}?scope=future", headers=POST).status_code == 204
    titles = [i["title"] for i in env.client.get("/api/todo/day/2026-11-26").json()["items"]]
    assert "달리기" not in titles
    trash = env.client.get("/api/todo/ai").json()["trash"]
    assert trash[0]["kind"] == "bundle" and "달리기" in trash[0]["title"]
    env.client.post(f"/api/todo/ai/trash/{trash[0]['id']}/restore", headers=POST)
    titles = [i["title"] for i in env.client.get("/api/todo/day/2026-11-26").json()["items"]]
    assert "달리기" in titles
    # 카테고리 지우기 → TODO와 반복이 같이 사라졌다가 되살아남
    assert env.client.delete(f"/api/todo/categories/{cat}", headers=POST).status_code == 204
    names = [c["name"] for c in env.client.get("/api/todo/categories").json()["categories"]]
    assert "운동" not in names
    trash = env.client.get("/api/todo/ai").json()["trash"]
    assert trash[0]["title"].startswith("'운동' 카테고리")
    env.client.post(f"/api/todo/ai/trash/{trash[0]['id']}/restore", headers=POST)
    names = [c["name"] for c in env.client.get("/api/todo/categories").json()["categories"]]
    assert "운동" in names
    titles = [i["title"] for i in env.client.get("/api/todo/day/2026-11-23").json()["items"]]
    assert {"달리기", "스트레칭"} <= set(titles)
    assert "달리기" in [
        i["title"] for i in env.client.get("/api/todo/day/2026-11-27").json()["items"]
    ]


def test_ai_repeats(env: Env) -> None:
    """AI도 반복 화면 일(만들기, 기간, 바꾸기, 지우기)을 두 단계로(2026-11-22 사용자 요청)."""
    _client_id, issued = connect(env)
    token = issued["access_token"]
    asked = call(
        env,
        token,
        "create_repeat",
        {
            "title": "출근",
            "category": "TODO",
            "rule": "weekly",
            "weekdays": ["월", "수", "금"],
            "start_day": "2026-12-21",
            "end_day": "2026-12-31",
            "skip_holidays": True,
            "time": "09:00",
        },
    )
    summary = asked["structuredContent"]["summary"]
    assert "매주 월 수 금" in summary and "공휴일 빼기" in summary
    done = call(
        env, token, "confirm_action", {"confirm_id": asked["structuredContent"]["confirm_id"]}
    )
    assert "반복을 만들었어요" in done["content"][0]["text"]
    listed = call(env, token, "list_repeats")
    series_id = listed["structuredContent"]["repeats"][0]["id"]
    assert "출근" in listed["content"][0]["text"]
    asked = call(env, token, "update_repeat", {"repeat": series_id, "place": "본사"})
    call(env, token, "confirm_action", {"confirm_id": asked["structuredContent"]["confirm_id"]})
    listed = call(env, token, "list_repeats")
    assert listed["structuredContent"]["repeats"][0]["current"]["place"] == "본사"
    assert listed["structuredContent"]["repeats"][0]["current"]["end_day"] == "2026-12-31"
    asked = call(env, token, "delete_repeat", {"repeat": series_id})
    call(env, token, "confirm_action", {"confirm_id": asked["structuredContent"]["confirm_id"]})
    assert call(env, token, "list_repeats")["structuredContent"]["repeats"] == []

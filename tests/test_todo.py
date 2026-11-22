"""할 일 기능(공개 전): 기능 스위치, 하루 보기, 쓰기, 검사, 남의 것 막기."""

from __future__ import annotations

import asyncio
import base64
from collections.abc import Iterator
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mos.api.app import create_app
from mos.config import load_settings
from mos.db.database import Database
from mos.db.repo import MessageRepo
from mos.services.permissions import PermissionService
from mos.services.realtime import RealtimeHub
from tests.test_api import (
    GUILD,
    ORIGIN,
    POST,
    Env,
    FakeDirectory,
    FakeMessenger,
    FakeOAuth,
    session,
    signed_up,
)

DAY = "2026-11-22"
BASE_ENV = {
    "DISCORD_BOT_TOKEN": "t",
    "DISCORD_CLIENT_ID": "1573318317446529064",
    "DISCORD_CLIENT_SECRET": "s",
    "MOS_SECRET_KEY": base64.urlsafe_b64encode(b"k" * 32).decode(),
    "PUBLIC_ORIGIN": ORIGIN,
}


def build(tmp_path: Path, todo_users: frozenset[int] | None) -> Iterator[Env]:
    settings = load_settings({**BASE_ENV, "DB_PATH": str(tmp_path / "todo.db")})
    # 테스트 사용자 ID(42, 43)는 짧아서 환경 변수 대신 설정을 바로 바꾼다
    settings = replace(settings, todo_users=todo_users)
    db = Database(settings.db_path)
    repo = MessageRepo(db)
    hub = RealtimeHub()
    bot = FakeDirectory()
    permissions = PermissionService(bot)
    oauth = FakeOAuth()
    messenger = FakeMessenger()
    oauth.add("mocha", 42, "모카", {GUILD})
    oauth.add("latte", 43, "라떼", {GUILD})
    clock = [1_800_000_000.0]
    app = create_app(
        settings,
        db,
        repo,
        hub,
        bot,
        oauth=oauth,
        clock=lambda: clock[0],
        permissions=permissions,
        messenger=messenger,
    )
    with TestClient(app, base_url=ORIGIN) as client:
        yield Env(client, bot, hub, repo, oauth, clock, permissions, messenger, app)


@pytest.fixture
def env(tmp_path: Path) -> Iterator[Env]:
    yield from build(tmp_path, frozenset({42}))  # 모카만 허용(운영자 대신)


def first_category(env: Env) -> str:
    return env.client.get(f"/api/todo/day/{DAY}").json()["categories"][0]["id"]


def add(env: Env, title: str = "치과", **extra: object) -> dict:
    body = {"title": title, "day": DAY, "category_id": first_category(env), **extra}
    response = env.client.post("/api/todo/items", json=body, headers=POST)
    assert response.status_code == 200, response.text
    return response.json()


# ------------------------------------------------------------ 기능 스위치


def test_hidden_from_accounts_not_allowed(env: Env) -> None:
    unknown = env.client.get("/api/nothing-here")  # 정말 없는 주소
    signed_up(env, "latte")
    assert "features" not in session(env)["accounts"][0]
    for method, path, kwargs in [
        ("GET", f"/api/todo/day/{DAY}", {}),
        ("GET", "/api/todo/categories", {}),
        ("POST", "/api/todo/items", {"json": {}, "headers": POST}),
        ("POST", "/api/todo/items", {"json": {}}),  # Origin 없어도 403이 아니라 404
        ("DELETE", "/api/todo/days", {"headers": POST}),  # 없는 방식도 405가 아니라 404
        ("GET", "/api/todo", {}),
    ]:
        response = env.client.request(method, path, **kwargs)
        assert response.status_code == 404, (method, path)
        assert response.json() == unknown.json() == {"detail": "Not Found"}


def test_hidden_without_login(env: Env) -> None:
    assert env.client.get(f"/api/todo/day/{DAY}").status_code == 404


def test_allowed_account_sees_feature(env: Env) -> None:
    signed_up(env, "mocha")
    account = session(env)["accounts"][0]
    assert account["features"] == ["todo"]
    assert account["preview_features"] == ["todo"]  # 공개 전 '나만 보임'


def test_locked_account_is_hidden(env: Env) -> None:
    signed_up(env, "mocha")
    env.client.post("/api/session/lock", headers=POST)
    assert env.client.get(f"/api/todo/day/{DAY}").status_code == 404


def test_public_switch_opens_for_everyone(tmp_path: Path) -> None:
    for open_env in build(tmp_path, None):
        signed_up(open_env, "latte")
        account = session(open_env)["accounts"][0]
        assert account["features"] == ["todo"] and "preview_features" not in account
        assert open_env.client.get(f"/api/todo/day/{DAY}").status_code == 200


def test_todo_users_setting() -> None:
    def users(raw: str) -> frozenset[int] | None:
        return load_settings({**BASE_ENV, "TODO_USERS": raw}).todo_users

    assert users("") == frozenset()
    assert users("all") is None
    assert users("1557254393902923793, 1573318317446529064") == {
        1557254393902923793,
        1573318317446529064,
    }
    assert users("1557254393902923793,모카") == frozenset()  # 잘못 적으면 운영자만


def test_operator_is_always_allowed() -> None:
    from mos.services.todo_access import TodoAccess

    settings = load_settings({**BASE_ENV, "OPERATOR_DISCORD_ID": "1557254393902923793"})
    access = TodoAccess(settings)
    assert access.allowed(1557254393902923793)
    assert not access.allowed(1573318317446529064)


# ------------------------------------------------------------ 하루와 할 일


def test_first_category_is_yellow(env: Env) -> None:
    signed_up(env, "mocha")
    day = env.client.get(f"/api/todo/day/{DAY}").json()
    assert day["day"] == DAY and day["items"] == []
    assert [(c["name"], c["color"]) for c in day["categories"]] == [("할 일", "#FFD66B")]
    # 두 번 열어도 하나만
    assert len(env.client.get("/api/todo/categories").json()["categories"]) == 1


def test_add_complete_move_delete(env: Env) -> None:
    signed_up(env, "mocha")
    item = add(env, "  치과   가기 ", time="15:00", place="강남역", memo="보험증 챙기기")
    assert (item["title"], item["time"], item["place"], item["memo"]) == (
        "치과 가기",
        "15:00",
        "강남역",
        "보험증 챙기기",
    )
    assert item["done"] is False and item["source"] == "app"
    done = env.client.patch(f"/api/todo/items/{item['id']}", json={"done": True}, headers=POST)
    assert done.json()["done"] is True
    summary = env.client.get(f"/api/todo/days?start={DAY}&end=2026-11-28").json()
    assert summary["days"] == {DAY: {"total": 1, "done": 1}}
    moved = env.client.patch(
        f"/api/todo/items/{item['id']}", json={"day": "2026-11-23"}, headers=POST
    ).json()
    assert moved["day"] == "2026-11-23"
    assert env.client.get(f"/api/todo/day/{DAY}").json()["items"] == []
    gone = env.client.delete(f"/api/todo/items/{item['id']}", headers=POST)
    assert gone.status_code == 204
    assert env.client.get("/api/todo/day/2026-11-23").json()["items"] == []


def test_reorder_items(env: Env) -> None:
    signed_up(env, "mocha")
    ids = [add(env, name)["id"] for name in ("하나", "둘", "셋")]
    category = first_category(env)
    body = {"day": DAY, "category_id": category, "ids": [ids[2], ids[0], ids[1]]}
    assert env.client.put("/api/todo/order", json=body, headers=POST).status_code == 204
    titles = [item["title"] for item in env.client.get(f"/api/todo/day/{DAY}").json()["items"]]
    assert titles == ["셋", "하나", "둘"]
    bad = {"day": DAY, "category_id": category, "ids": ids[:2]}
    assert env.client.put("/api/todo/order", json=bad, headers=POST).status_code == 400


@pytest.mark.parametrize(
    ("body", "code"),
    [
        ({"title": ""}, "bad_title"),
        ({"title": "가" * 101}, "bad_title"),
        ({"day": "2026-02-30"}, "bad_day"),
        ({"day": "26-11-22"}, "bad_day"),
        ({"time": "24:00"}, "bad_time"),
        ({"time": "3시"}, "bad_time"),
        ({"place": "가" * 41}, "bad_place"),
        ({"memo": "가" * 1001}, "bad_memo"),
    ],
)
def test_item_checks(env: Env, body: dict, code: str) -> None:
    signed_up(env, "mocha")
    full = {"title": "치과", "day": DAY, "category_id": first_category(env), **body}
    response = env.client.post("/api/todo/items", json=full, headers=POST)
    assert response.status_code == 400 and response.json()["detail"] == code


def test_categories(env: Env) -> None:
    signed_up(env, "mocha")
    first = first_category(env)
    made = env.client.post(
        "/api/todo/categories", json={"name": "업무", "color": "#2e8"}, headers=POST
    ).json()
    assert made["color"] == "#22EE88"  # 세 자리, 소문자도 받아서 #RRGGBB로
    same = env.client.post("/api/todo/categories", json={"name": "업무"}, headers=POST)
    assert same.status_code == 409 and same.json()["detail"] == "duplicate_name"
    bad = env.client.post("/api/todo/categories", json={"name": "x", "color": "red"}, headers=POST)
    assert bad.json()["detail"] == "bad_color"
    order = env.client.put(
        "/api/todo/categories/order", json={"ids": [made["id"], first]}, headers=POST
    ).json()
    assert [c["name"] for c in order["categories"]] == ["업무", "할 일"]
    env.tick(1)  # 쓰기는 계정당 1초 5번
    closed = env.client.patch(
        f"/api/todo/categories/{made['id']}", json={"closed": True}, headers=POST
    ).json()
    assert closed["closed"] is True
    # 끝낸 카테고리에는 새 할 일을 넣을 수 없다
    blocked = env.client.post(
        "/api/todo/items",
        json={"title": "보고서", "day": DAY, "category_id": made["id"]},
        headers=POST,
    )
    assert blocked.status_code == 409
    # 열린 카테고리가 하나뿐이면 끝내기, 지우기를 막는다
    last = env.client.delete(f"/api/todo/categories/{first}", headers=POST)
    assert last.status_code == 409 and last.json()["detail"] == "last_category"
    assert env.client.delete(f"/api/todo/categories/{made['id']}", headers=POST).status_code == 204


def test_cannot_touch_someone_elses(tmp_path: Path) -> None:
    for both in build(tmp_path, frozenset({42, 43})):
        signed_up(both, "mocha")
        item = add(both)
        category = first_category(both)
        both.client.cookies.clear()
        signed_up(both, "latte")
        for response in (
            both.client.patch(f"/api/todo/items/{item['id']}", json={"done": True}, headers=POST),
            both.client.delete(f"/api/todo/items/{item['id']}", headers=POST),
            both.client.patch(
                f"/api/todo/categories/{category}", json={"name": "뺏기"}, headers=POST
            ),
            both.client.post(
                "/api/todo/items",
                json={"title": "몰래", "day": DAY, "category_id": category},
                headers=POST,
            ),
        ):
            assert response.status_code == 404
        assert both.client.get(f"/api/todo/day/{DAY}").json()["items"] == []


def test_write_rate_limit(env: Env) -> None:
    signed_up(env, "mocha")
    category = first_category(env)
    codes = [
        env.client.post(
            "/api/todo/items",
            json={"title": f"할 일 {n}", "day": DAY, "category_id": category},
            headers=POST,
        ).status_code
        for n in range(6)
    ]
    assert codes[:5] == [200] * 5 and codes[5] == 429


# ------------------------------------------------------------ 반복, 최근 색


def day_items(env: Env, day: str) -> list[dict]:
    return env.client.get(f"/api/todo/day/{day}").json()["items"]


def test_daily_repeat(env: Env) -> None:
    signed_up(env, "mocha")
    item = add(env, "물 마시기")
    made = env.client.post(
        "/api/todo/repeats", json={"item_id": item["id"], "rule": "daily"}, headers=POST
    )
    assert made.status_code == 200 and made.json()["rule"] == "daily"
    today = day_items(env, DAY)
    assert today[0]["id"] == item["id"] and today[0]["repeat"]["rule"] == "daily"
    tomorrow = day_items(env, "2026-11-23")
    assert [i["id"] for i in tomorrow] == [f"r{made.json()['id']}:2026-11-23"]
    summary = env.client.get(f"/api/todo/days?start={DAY}&end=2026-11-28").json()["days"]
    assert summary["2026-11-25"] == {"total": 1, "done": 0}
    # 아직 행이 없는 회차도 완료할 수 있다(그때 행이 생김)
    done = env.client.patch(
        f"/api/todo/items/{tomorrow[0]['id']}", json={"done": True}, headers=POST
    ).json()
    assert done["done"] is True and done["id"].isdigit() and done["repeat"]["rule"] == "daily"
    assert day_items(env, "2026-11-23")[0]["done"] is True
    env.tick(1)
    # 오늘 것만 지우기: 그날만 빠진다
    skip = env.client.delete(f"/api/todo/items/r{made.json()['id']}:2026-11-24", headers=POST)
    assert skip.status_code == 204
    assert day_items(env, "2026-11-24") == []
    assert len(day_items(env, "2026-11-25")) == 1
    # 앞으로도 지우기: 그날부터 없다
    rid = made.json()["id"]
    gone = env.client.delete(f"/api/todo/items/r{rid}:2026-11-26?scope=future", headers=POST)
    assert gone.status_code == 204
    assert day_items(env, "2026-11-26") == [] and day_items(env, "2026-12-01") == []
    assert len(day_items(env, "2026-11-25")) == 1


def test_weekly_repeat_and_moving_one_day(env: Env) -> None:
    signed_up(env, "mocha")
    item = add(env, "운동")
    rid = env.client.post(
        "/api/todo/repeats",
        json={"item_id": item["id"], "rule": "weekly", "weekdays": [1, 3]},
        headers=POST,
    ).json()["id"]
    assert len(day_items(env, "2026-11-23")) == 1  # 월
    assert day_items(env, "2026-11-24") == []  # 화
    # 월요일 회차를 화요일로 옮기면 따로인 할 일이 되고 월요일은 비어 있다
    moved = env.client.patch(
        f"/api/todo/items/r{rid}:2026-11-23", json={"day": "2026-11-24"}, headers=POST
    ).json()
    assert moved["day"] == "2026-11-24" and moved["repeat"] is None
    assert day_items(env, "2026-11-23") == []
    assert [i["title"] for i in day_items(env, "2026-11-24")] == ["운동"]
    assert len(day_items(env, "2026-11-30")) == 1  # 다음 월요일은 그대로


def test_stop_repeat_keeps_that_day(env: Env) -> None:
    signed_up(env, "mocha")
    item = add(env, "일기")
    rid = env.client.post(
        "/api/todo/repeats", json={"item_id": item["id"], "rule": "daily"}, headers=POST
    ).json()["id"]
    stop = env.client.post(
        f"/api/todo/repeats/{rid}/stop", json={"day": "2026-11-24"}, headers=POST
    )
    assert stop.status_code == 204
    kept = day_items(env, "2026-11-24")
    assert [i["title"] for i in kept] == ["일기"] and kept[0]["repeat"] is None
    assert day_items(env, "2026-11-25") == []


def test_repeat_checks(env: Env) -> None:
    signed_up(env, "mocha")
    item = add(env, "청소")
    for body, code in [
        ({"rule": "yearly"}, "bad_rule"),
        ({"rule": "weekly", "weekdays": []}, "bad_weekdays"),
        ({"rule": "weekly", "weekdays": [7]}, "bad_weekdays"),
        ({"rule": "daily", "end_day": "2026-11-01"}, "bad_end_day"),
    ]:
        response = env.client.post(
            "/api/todo/repeats", json={"item_id": item["id"], **body}, headers=POST
        )
        assert response.json()["detail"] == code
    env.tick(1)
    ok = env.client.post(
        "/api/todo/repeats", json={"item_id": item["id"], "rule": "monthly"}, headers=POST
    )
    assert ok.status_code == 200
    again = env.client.post(
        "/api/todo/repeats", json={"item_id": item["id"], "rule": "daily"}, headers=POST
    )
    assert again.json()["detail"] == "already_repeating"
    assert len(day_items(env, "2026-12-22")) == 1 and day_items(env, "2026-12-21") == []


def test_reorder_with_repeat_occurrence(env: Env) -> None:
    signed_up(env, "mocha")
    first = add(env, "반복")
    env.client.post(
        "/api/todo/repeats", json={"item_id": first["id"], "rule": "daily"}, headers=POST
    )
    env.client.post(
        "/api/todo/items",
        json={"title": "한 번", "day": "2026-11-23", "category_id": first_category(env)},
        headers=POST,
    )
    ids = [i["id"] for i in day_items(env, "2026-11-23")]
    body = {"day": "2026-11-23", "category_id": first_category(env), "ids": list(reversed(ids))}
    env.tick(1)
    assert env.client.put("/api/todo/order", json=body, headers=POST).status_code == 204
    assert [i["title"] for i in day_items(env, "2026-11-23")] == ["한 번", "반복"]


def test_recent_colors(env: Env) -> None:
    signed_up(env, "mocha")
    env.client.post("/api/todo/categories", json={"name": "a", "color": "#2E8B57"}, headers=POST)
    env.client.post("/api/todo/categories", json={"name": "b", "color": "#2563EB"}, headers=POST)
    env.client.post("/api/todo/categories", json={"name": "c", "color": "#123456"}, headers=POST)
    recent = env.client.get("/api/todo/categories").json()["recent_colors"]
    assert recent == ["#123456", "#2E8B57"]  # 기본 색은 넣지 않고 최근 것 먼저


def test_alert_prefs(env: Env) -> None:
    signed_up(env, "mocha")
    assert env.client.get("/api/todo/prefs").json() == {
        "alert_lead": None,
        "morning": None,
        "tz": "Asia/Seoul",
        "morning_via": "push",
        "boss_mode": "off",
    }
    env.client.post("/api/todo/categories", json={"name": "a", "color": "#123456"}, headers=POST)
    env.tick(1)
    saved = env.client.patch(
        "/api/todo/prefs", json={"alert_lead": 10, "morning": "08:00", "tz": "UTC"}, headers=POST
    ).json()
    assert saved == {
        "alert_lead": 10,
        "morning": "08:00",
        "tz": "UTC",
        "morning_via": "push",
        "boss_mode": "off",
    }
    # 최근 색 같은 다른 설정은 그대로
    assert env.client.get("/api/todo/categories").json()["recent_colors"] == ["#123456"]
    env.tick(1)
    for bad in (
        {"alert_lead": 5},
        {"alert_lead": True},
        {"morning": "8:00"},
        {"tz": "../etc/passwd"},
        {"tz": "Mars/Base"},
        {"morning_via": "email"},
        {"boss_mode": "loud"},
        {"other": 1},
    ):
        env.tick(1)
        response = env.client.patch("/api/todo/prefs", json=bad, headers=POST)
        assert response.status_code == 400, bad


def test_time_alert_and_morning_summary(env: Env) -> None:
    signed_up(env, "mocha")
    alerts = env.app.state.todo_alerts
    # 시계: 2027-01-15 17:00 KST
    day = "2027-01-15"
    category = first_category(env)
    for title, time_ in (("치과", "17:10"), ("운동", "17:10"), ("빨래", None)):
        env.tick(1)
        body = {"title": title, "day": day, "category_id": category}
        if time_:
            body["time"] = time_
        assert env.client.post("/api/todo/items", json=body, headers=POST).status_code == 200
    env.tick(1)
    env.client.patch("/api/todo/prefs", json={"alert_lead": 10, "morning": "16:50"}, headers=POST)

    env.clock[0] = 1_800_000_000.0 + 5  # 17:00:05, 10분 전 = 지금
    due = asyncio.run(alerts.due())
    assert len(due) == 1
    account_id, payload = due[0].account_id, due[0].push
    assert due[0].dm is None and due[0].boss == "off"
    assert payload is not None
    assert payload["kind"] == "todo" and payload["url"] == "/#/todo"
    assert "10분 뒤" in payload["title"]
    # 아침 요약(16:50, 30분 안)도 같이 하나로
    assert payload["body"].startswith("17:10 치과 외 1개")
    assert "빨래" in payload["body"]
    # 같은 것을 두 번 보내지 않는다
    assert asyncio.run(alerts.due()) == []
    # 3분 넘게 늦은 알림은 보내지 않는다
    env.clock[0] = 1_800_000_000.0 + 600
    assert asyncio.run(alerts.due()) == []
    # 알림을 보낼 곳이 없어도 실패하지 않는다
    asyncio.run(env.app.state.send_todo_alerts())
    assert account_id > 0


def test_alerts_off_by_default(env: Env) -> None:
    signed_up(env, "mocha")
    env.client.post(
        "/api/todo/items",
        json={
            "title": "치과",
            "day": "2027-01-15",
            "time": "17:00",
            "category_id": first_category(env),
        },
        headers=POST,
    )
    assert asyncio.run(env.app.state.todo_alerts.due()) == []


def test_morning_by_dm_and_news(env: Env) -> None:
    signed_up(env, "mocha")
    alerts = env.app.state.todo_alerts
    day = "2027-01-15"
    env.client.post(
        "/api/todo/items",
        json={"title": "빨래", "day": day, "category_id": first_category(env)},
        headers=POST,
    )
    env.tick(1)
    body = {"morning": "17:00", "morning_via": "dm", "boss_mode": "full"}
    env.client.patch("/api/todo/prefs", json=body, headers=POST)
    env.clock[0] = 1_800_000_000.0 + 30
    due = asyncio.run(alerts.due())
    assert len(due) == 1
    assert due[0].push is None  # DM만 고르면 기기 알림은 없음
    assert due[0].dm is not None and "빨래" in due[0].dm
    assert due[0].boss == "full"
    news = env.client.get("/api/todo/news").json()
    assert news["unread"] == 1
    assert news["items"][0]["title"] == "오늘 할 일 1개"
    env.tick(1)
    assert env.client.post("/api/todo/news/seen", headers=POST).status_code == 204
    assert env.client.get("/api/todo/news").json()["unread"] == 0

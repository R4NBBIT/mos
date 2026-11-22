"""할 일 친구(T4): 같은 서버 사람만, 요청과 수락, 공개 범위대로 보기, 메모 숨김, 반응, 소식."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from tests.test_api import POST, Env, signed_up
from tests.test_todo import build

DAY = "2026-11-23"
SMILE = "<:smile:1573320336554852801>"
DANCE = "<a:dance:1573320336554852802>"


@pytest.fixture
def env(tmp_path: Path) -> Iterator[Env]:
    yield from build(tmp_path, frozenset({42, 43}))


def use(env: Env, account_id: str) -> None:
    response = env.client.post("/api/session/switch", json={"account_id": account_id}, headers=POST)
    assert response.status_code == 204


def two(env: Env) -> tuple[str, str]:
    mocha = signed_up(env, "mocha")
    latte = signed_up(env, "latte")
    return mocha, latte


def befriend(env: Env, mocha: str, latte: str) -> None:
    use(env, mocha)
    assert env.client.post(f"/api/todo/people/{latte}/request", headers=POST).json() == {
        "state": "pending"
    }
    env.tick(1)
    use(env, latte)
    people = env.client.get("/api/todo/people").json()
    assert [p["name"] for p in people["incoming"]] == ["모카"]
    assert env.client.post(f"/api/todo/people/{mocha}/accept", headers=POST).json() == {
        "state": "friends"
    }
    env.tick(1)


def test_candidates_request_accept(env: Env) -> None:
    mocha, latte = two(env)
    use(env, mocha)
    people = env.client.get("/api/todo/people").json()
    assert [p["name"] for p in people["candidates"]] == ["라떼"]
    befriend(env, mocha, latte)
    use(env, mocha)
    people = env.client.get("/api/todo/people").json()
    assert [p["name"] for p in people["friends"]] == ["라떼"] and people["candidates"] == []
    news = env.client.get("/api/todo/news").json()
    assert news["items"][0]["kind"] == "friend_accept"
    # 끊기
    env.tick(1)
    assert env.client.delete(f"/api/todo/people/{latte}", headers=POST).status_code == 204
    assert env.client.get("/api/todo/people").json()["friends"] == []


def test_accept_requests_off_hides_me(env: Env) -> None:
    mocha, latte = two(env)
    use(env, latte)
    env.client.patch("/api/todo/people/settings", json={"accept_requests": False}, headers=POST)
    use(env, mocha)
    assert env.client.get("/api/todo/people").json()["candidates"] == []
    response = env.client.post(f"/api/todo/people/{latte}/request", headers=POST)
    assert response.status_code == 404


def test_visibility_and_memo(env: Env) -> None:
    mocha, latte = two(env)
    use(env, latte)
    cats = env.client.get("/api/todo/categories").json()["categories"]
    first = cats[0]["id"]  # 기본 '친구'
    pub = env.client.post(
        "/api/todo/categories",
        json={"name": "공개", "color": "#2563EB", "visibility": "public"},
        headers=POST,
    ).json()["id"]
    env.tick(1)
    secret = env.client.post(
        "/api/todo/categories",
        json={"name": "비밀", "color": "#2563EB", "visibility": "private"},
        headers=POST,
    ).json()["id"]
    env.tick(1)
    for title, cat in (("친구용", first), ("모두용", pub), ("나만", secret)):
        env.client.post(
            "/api/todo/items",
            json={"title": title, "day": DAY, "category_id": cat, "memo": "메모"},
            headers=POST,
        )
        env.tick(1)
    # 친구가 아니면 '전체'만
    use(env, mocha)
    seen = env.client.get(f"/api/todo/friends/{latte}/day/{DAY}").json()
    assert seen["relation"] == "server"
    assert [i["title"] for i in seen["items"]] == ["모두용"]
    assert seen["items"][0]["memo"] == ""  # 메모 공개가 꺼져 있으면 빈 메모
    befriend(env, mocha, latte)
    use(env, latte)
    env.client.patch(f"/api/todo/categories/{pub}", json={"memo_shared": True}, headers=POST)
    use(env, mocha)
    seen = env.client.get(f"/api/todo/friends/{latte}/day/{DAY}").json()
    assert seen["relation"] == "friend"
    assert sorted(i["title"] for i in seen["items"]) == ["모두용", "친구용"]
    memo = {i["title"]: i["memo"] for i in seen["items"]}
    assert memo == {"모두용": "메모", "친구용": ""}
    today = env.client.get(f"/api/todo/friends/today?day={DAY}").json()["friends"]
    assert today == [{**today[0], "name": "라떼", "done": 0, "total": 2}]


def test_reactions(env: Env) -> None:
    mocha, latte = two(env)
    befriend(env, mocha, latte)
    use(env, latte)
    cat = env.client.get("/api/todo/categories").json()["categories"][0]["id"]
    item = env.client.post(
        "/api/todo/items", json={"title": "운동", "day": DAY, "category_id": cat}, headers=POST
    ).json()["id"]
    env.tick(1)
    use(env, mocha)
    react = lambda emoji, on=True: env.client.post(  # noqa: E731
        "/api/todo/react",
        json={"owner": latte, "item": item, "emoji": emoji, "on": on},
        headers=POST,
    )
    assert react("👍").status_code == 200
    assert react(SMILE).status_code == 200
    env.tick(1)
    # 모카는 니트로가 없어 움직이는 이모지는 못 씀, 글자는 이모지가 아님
    assert react(DANCE).status_code == 400
    assert react("ab").status_code == 400
    assert react("<script>").status_code == 400
    env.tick(1)
    assert react("🧑‍🍳").status_code == 200  # 합친 이모지
    use(env, latte)
    items = env.client.get(f"/api/todo/day/{DAY}").json()["items"]
    reactions = items[0]["reactions"]
    assert [(r["emoji"], r["count"], r["mine"]) for r in reactions] == [
        ("👍", 1, False),
        (SMILE, 1, False),
        ("🧑‍🍳", 1, False),
    ]
    news = env.client.get("/api/todo/news").json()["items"]
    reaction_news = [n for n in news if n["kind"] == "reaction"]
    assert len(reaction_news) == 1  # 1분 안 반응은 하나로
    assert "👍" in reaction_news[0]["body"] and ":smile:" in reaction_news[0]["body"]
    # 떼기
    use(env, mocha)
    response = react("👍", on=False)
    assert [r["emoji"] for r in response.json()["reactions"]] == [SMILE, "🧑‍🍳"]


def test_cannot_react_to_private(env: Env) -> None:
    mocha, latte = two(env)
    befriend(env, mocha, latte)
    use(env, latte)
    secret = env.client.post(
        "/api/todo/categories",
        json={"name": "비밀", "color": "#2563EB", "visibility": "private"},
        headers=POST,
    ).json()["id"]
    env.tick(1)
    item = env.client.post(
        "/api/todo/items", json={"title": "비밀", "day": DAY, "category_id": secret}, headers=POST
    ).json()["id"]
    use(env, mocha)
    response = env.client.post(
        "/api/todo/react",
        json={"owner": latte, "item": item, "emoji": "👍", "on": True},
        headers=POST,
    )
    assert response.status_code == 404


def test_emoji_list(env: Env) -> None:
    signed_up(env, "latte")
    names = [e["name"] for e in env.client.get("/api/todo/emojis").json()["emojis"]]
    assert names == ["smile"]  # 움직이는 것(니트로), 역할 전용(vip)은 빠짐


def test_groups_and_selected_visibility(env: Env) -> None:
    mocha, latte = two(env)
    befriend(env, mocha, latte)
    use(env, latte)
    secret = env.client.post(
        "/api/todo/categories",
        json={"name": "골라서", "color": "#2563EB", "visibility": "selected"},
        headers=POST,
    ).json()["id"]
    env.tick(1)
    env.client.post(
        "/api/todo/items", json={"title": "몰래", "day": DAY, "category_id": secret}, headers=POST
    )
    env.tick(1)
    # 아무도 안 골랐으면 친구도 못 봄
    use(env, mocha)
    assert env.client.get(f"/api/todo/friends/{latte}/day/{DAY}").json()["items"] == []
    use(env, latte)
    group = env.client.post(
        "/api/todo/groups", json={"name": "회사", "members": [mocha]}, headers=POST
    ).json()
    assert [m["name"] for m in group["members"]] == ["모카"]
    env.tick(1)
    # 그룹과 그 안의 친구를 같이 고르면 친구는 따로 넣지 않는다
    saved = env.client.put(
        f"/api/todo/categories/{secret}/audience",
        json={"friends": [mocha], "groups": [group["id"]]},
        headers=POST,
    ).json()
    assert saved == {"friends": [], "groups": [group["id"]]}
    use(env, mocha)
    assert [
        i["title"] for i in env.client.get(f"/api/todo/friends/{latte}/day/{DAY}").json()["items"]
    ] == ["몰래"]
    # 친구가 아닌 사람은 고를 수 없다
    use(env, latte)
    env.tick(1)
    bad = env.client.put(
        f"/api/todo/categories/{secret}/audience", json={"friends": ["99999"]}, headers=POST
    )
    assert bad.status_code == 400
    # 그룹을 지우면 휴지통으로, 되살리면 대상도 다시
    env.tick(1)
    env.client.delete(f"/api/todo/groups/{group['id']}", headers=POST)
    assert env.client.get("/api/todo/groups").json()["groups"] == []
    trash = env.client.get("/api/todo/ai").json()["trash"]
    assert trash[0]["title"] == "'회사' 그룹"
    env.tick(1)
    env.client.post(f"/api/todo/ai/trash/{trash[0]['id']}/restore", headers=POST)
    group = env.client.get("/api/todo/groups").json()["groups"][0]
    assert env.client.get(f"/api/todo/categories/{secret}/audience").json()["groups"] == [
        group["id"]
    ]
    # 그룹에서 빼면 다시 못 봄
    env.tick(1)
    env.client.patch(f"/api/todo/groups/{group['id']}", json={"members": []}, headers=POST)
    use(env, mocha)
    assert env.client.get(f"/api/todo/friends/{latte}/day/{DAY}").json()["items"] == []
    # 친구를 끊으면 그룹과 대상에서도 빠진다
    use(env, latte)
    env.tick(1)
    env.client.put(
        f"/api/todo/categories/{secret}/audience", json={"friends": [mocha]}, headers=POST
    )
    env.tick(1)
    env.client.delete(f"/api/todo/people/{mocha}", headers=POST)
    assert env.client.get(f"/api/todo/categories/{secret}/audience").json() == {
        "friends": [],
        "groups": [],
    }

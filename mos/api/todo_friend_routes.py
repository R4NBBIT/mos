"""할 일 친구, 반응 API(T4). 모두 /api/todo 아래라 허용 안 된 계정에는 404(미들웨어)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response

from mos.api.rate_limit import RateLimiter
from mos.services.session import ActiveAccount, SessionError
from mos.services.todo import TodoError, clean_day
from mos.services.todo_friends import TodoFriends

# (디스코드 사용자 ID, 니트로) → 쓸 수 있는 디스코드 이모지(화면용 목록)
EmojiList = Callable[[int, bool], Awaitable[list[dict[str, Any]]]]


def register_todo_friend_routes(
    app: FastAPI,
    *,
    todo_account: Callable[[Request], Awaitable[ActiveAccount]],
    friends: TodoFriends,
    emoji_list: EmojiList,
    clock: Callable[[], float],
) -> None:
    limiter = RateLimiter(limit=10, window_sec=2, clock=clock)

    async def writer(request: Request) -> ActiveAccount:
        account = await todo_account(request)
        if not limiter.allow(f"friend:{account.account_id}"):
            raise SessionError("rate_limited", status=429, retry_after=1)
        return account

    async def body_of(request: Request) -> dict[str, Any]:
        try:
            body = await request.json()
        except ValueError as error:
            raise HTTPException(status_code=400, detail="bad_json") from error
        if not isinstance(body, dict) or len(body) > 8:
            raise HTTPException(status_code=400, detail="bad_json")
        return body

    @app.get("/api/todo/people")
    async def todo_people(request: Request) -> dict[str, Any]:
        account = await todo_account(request)
        return await friends.people(account.account_id)

    @app.patch("/api/todo/people/settings", status_code=204)
    async def todo_people_settings(request: Request) -> Response:
        account = await writer(request)
        body = await body_of(request)
        await friends.set_accept_requests(account.account_id, body.get("accept_requests"))
        return Response(status_code=204)

    @app.post("/api/todo/people/{other_id}/request")
    async def todo_friend_request(other_id: str, request: Request) -> dict[str, str]:
        account = await writer(request)
        return {"state": await friends.request(account.account_id, other_id)}

    @app.post("/api/todo/people/{other_id}/accept")
    async def todo_friend_accept(other_id: str, request: Request) -> dict[str, str]:
        account = await writer(request)
        return {"state": await friends.accept(account.account_id, other_id)}

    @app.delete("/api/todo/people/{other_id}", status_code=204)
    async def todo_friend_remove(other_id: str, request: Request) -> Response:
        account = await writer(request)
        await friends.remove(account.account_id, other_id)
        return Response(status_code=204)

    @app.post("/api/todo/people/{other_id}/block", status_code=204)
    async def todo_friend_block(other_id: str, request: Request) -> Response:
        account = await writer(request)
        await friends.block(account.account_id, other_id)
        return Response(status_code=204)

    @app.delete("/api/todo/people/{other_id}/block", status_code=204)
    async def todo_friend_unblock(other_id: str, request: Request) -> Response:
        account = await writer(request)
        await friends.unblock(account.account_id, other_id)
        return Response(status_code=204)

    @app.get("/api/todo/friends/today")
    async def todo_friends_today(request: Request, day: str = "") -> dict[str, Any]:
        account = await todo_account(request)
        return {"friends": await friends.friends_today(account.account_id, clean_day(day))}

    @app.get("/api/todo/friends/{owner_id}/day/{day}")
    async def todo_friend_day(owner_id: str, day: str, request: Request) -> dict[str, Any]:
        account = await todo_account(request)
        return await friends.day_for(account.account_id, owner_id, clean_day(day))

    @app.post("/api/todo/react")
    async def todo_react(request: Request) -> dict[str, Any]:
        account = await writer(request)
        body = await body_of(request)
        owner = body.get("owner") or str(account.account_id)
        reactions = await friends.react(
            account.account_id, owner, body.get("item"), body.get("emoji"), body.get("on")
        )
        return {"reactions": reactions}

    # ------------------------------------------------------------ 친구 그룹, 일부 공개 대상

    @app.get("/api/todo/groups")
    async def todo_groups(request: Request) -> dict[str, Any]:
        account = await todo_account(request)
        return {"groups": await friends.groups(account.account_id)}

    @app.post("/api/todo/groups")
    async def todo_group_add(request: Request) -> dict[str, Any]:
        account = await writer(request)
        return await friends.create_group(account.account_id, await body_of(request))

    @app.patch("/api/todo/groups/{group_id}", status_code=204)
    async def todo_group_edit(group_id: str, request: Request) -> Response:
        account = await writer(request)
        body = await body_of(request)
        if "name" in body:
            await friends.rename_group(account.account_id, group_id, body["name"])
        if "members" in body:
            await friends.set_members(account.account_id, group_id, body["members"])
        return Response(status_code=204)

    @app.delete("/api/todo/groups/{group_id}", status_code=204)
    async def todo_group_delete(group_id: str, request: Request) -> Response:
        account = await writer(request)
        await friends.delete_group(account.account_id, group_id)
        return Response(status_code=204)

    @app.get("/api/todo/categories/{category_id}/audience")
    async def todo_audience(category_id: str, request: Request) -> dict[str, Any]:
        account = await todo_account(request)
        return await friends.audience(account.account_id, category_id)

    @app.put("/api/todo/categories/{category_id}/audience")
    async def todo_audience_set(category_id: str, request: Request) -> dict[str, Any]:
        account = await writer(request)
        return await friends.set_audience(account.account_id, category_id, await body_of(request))

    @app.get("/api/todo/emojis")
    async def todo_emojis(request: Request) -> dict[str, Any]:
        account = await todo_account(request)
        return {"emojis": await emoji_list(account.discord_user_id, account.premium)}

    _ = TodoError  # 오류는 todo_routes의 처리기가 같은 모양으로 돌려준다

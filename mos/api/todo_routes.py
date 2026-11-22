"""할 일 API(/api/todo/*). 공개 전에는 허용된 계정만 쓰고, 나머지에게는 전부 404."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from mos.api.rate_limit import RateLimiter
from mos.services.session import ActiveAccount, SessionError
from mos.services.todo import TodoError, TodoService, category_to_api, parse_id
from mos.services.todo_access import TodoAccess

MAX_BODY_KEYS = 12
NOT_FOUND = {"detail": "Not Found"}  # 없는 주소일 때 프레임워크가 주는 본문과 똑같이
PREFIX = "/api/todo"


def register_todo_routes(
    app: FastAPI,
    require_account: Callable[[Request], Awaitable[ActiveAccount]],
    access: TodoAccess,
    todo: TodoService,
    clock: Callable[[], float],
) -> Callable[[Request], Awaitable[ActiveAccount]]:
    """할 일 API를 붙이고, 다른 할 일 주소(AI 연결)가 쓸 계정 확인 함수를 돌려준다."""
    write_limiter = RateLimiter(limit=5, window_sec=1, clock=clock)

    async def allowed_request(request: Request) -> bool:
        try:
            account = await require_account(request)
        except SessionError:
            return False
        return access.allowed(account.discord_user_id)

    @app.middleware("http")
    async def hide_todo(request: Request, call_next: Any) -> Any:
        # 허용되지 않으면 /api/todo 아래 어떤 주소, 방식이든 없는 주소와 똑같이(405, 403도 숨김)
        path = request.url.path
        if (path == PREFIX or path.startswith(PREFIX + "/")) and not await allowed_request(request):
            return JSONResponse(NOT_FOUND, status_code=404)
        return await call_next(request)

    @app.exception_handler(TodoError)
    async def todo_error(_request: Request, error: TodoError) -> JSONResponse:
        if error.status == 404:
            return JSONResponse(NOT_FOUND, status_code=404)
        return JSONResponse({"detail": error.code}, status_code=error.status)

    async def todo_account(request: Request) -> ActiveAccount:
        """잠김, 로그인 안 함, 허용 안 됨 모두 같은 404(기능이 있는지조차 모르게)."""
        try:
            account = await require_account(request)
        except SessionError as error:
            raise TodoError("not_found", 404) from error
        if not access.allowed(account.discord_user_id):
            raise TodoError("not_found", 404)
        return account

    async def writer(request: Request) -> ActiveAccount:
        account = await todo_account(request)
        if not write_limiter.allow(f"account:{account.account_id}"):
            raise SessionError("rate_limited", status=429, retry_after=1)
        return account

    async def json_body(request: Request) -> dict[str, Any]:
        try:
            body = await request.json()
        except ValueError as error:
            raise HTTPException(status_code=400, detail="bad_json") from error
        if not isinstance(body, dict) or len(body) > MAX_BODY_KEYS:
            raise HTTPException(status_code=400, detail="bad_json")
        return body

    # ------------------------------------------------------------ 보기

    @app.get("/api/todo/day/{day}")
    async def todo_day(day: str, request: Request) -> dict[str, Any]:
        account = await todo_account(request)
        data = await todo.day(account.account_id, day)
        if todo.decorate is not None:  # 내 할 일에 달린 반응(T4)
            await todo.decorate(account.account_id, account.account_id, data["items"])
        return data

    @app.get("/api/todo/days")
    async def todo_days(request: Request, start: str = "", end: str = "") -> dict[str, Any]:
        account = await todo_account(request)
        return await todo.days(account.account_id, start, end)

    @app.get("/api/todo/categories")
    async def todo_categories(request: Request) -> dict[str, Any]:
        account = await todo_account(request)
        rows = await todo.categories(account.account_id)
        return {
            "categories": [category_to_api(row) for row in rows],
            "recent_colors": await todo.recent_colors(account.account_id),
        }

    # ------------------------------------------------------------ 할 일 쓰기

    @app.post("/api/todo/items")
    async def todo_add(request: Request) -> dict[str, Any]:
        account = await writer(request)
        return await todo.add_item(account.account_id, await json_body(request))

    @app.patch("/api/todo/items/{item_id}")
    async def todo_update(item_id: str, request: Request) -> dict[str, Any]:
        account = await writer(request)
        # 반복 회차는 r<반복 ID>:<날짜> 모양의 ID로 온다(서비스가 검사)
        return await todo.update_item(account.account_id, item_id, await json_body(request))

    @app.delete("/api/todo/items/{item_id}", status_code=204)
    async def todo_delete(item_id: str, request: Request, scope: str = "today") -> None:
        account = await writer(request)
        if scope not in ("today", "future"):
            raise TodoError("bad_scope")
        if scope == "today" and todo.trash is not None:
            # 앱에서 지운 것도 휴지통에 7일(되돌리기)
            if not await todo.trash(account.account_id, item_id):
                raise TodoError("not_found", 404)
            return
        await todo.delete_item(account.account_id, item_id, scope)

    # ------------------------------------------------------------ 알림 설정(NOTI-01, NOTI-03)

    @app.get("/api/todo/prefs")
    async def todo_prefs(request: Request) -> dict[str, Any]:
        account = await todo_account(request)
        return await todo.alert_prefs(account.account_id)

    @app.patch("/api/todo/prefs")
    async def todo_prefs_update(request: Request) -> dict[str, Any]:
        account = await writer(request)
        return await todo.update_alert_prefs(account.account_id, await json_body(request))

    # ------------------------------------------------------------ 소식(NOTI-06)

    @app.get("/api/todo/news")
    async def todo_news(request: Request) -> dict[str, Any]:
        account = await todo_account(request)
        return await todo.news(account.account_id)

    @app.post("/api/todo/news/seen", status_code=204)
    async def todo_news_seen(request: Request) -> None:
        account = await writer(request)
        await todo.news_seen(account.account_id)

    # ------------------------------------------------------------ 반복

    @app.post("/api/todo/repeats")
    async def todo_repeat_add(request: Request) -> dict[str, Any]:
        account = await writer(request)
        return await todo.create_repeat(account.account_id, await json_body(request))

    @app.patch("/api/todo/repeats/{repeat_id}")
    async def todo_repeat_update(repeat_id: str, request: Request) -> dict[str, Any]:
        account = await writer(request)
        return await todo.update_repeat(
            account.account_id, parse_id(repeat_id), await json_body(request)
        )

    @app.post("/api/todo/repeats/{repeat_id}/stop", status_code=204)
    async def todo_repeat_stop(repeat_id: str, request: Request) -> None:
        account = await writer(request)
        body = await json_body(request)
        await todo.stop_repeat(account.account_id, parse_id(repeat_id), body.get("day"))

    @app.put("/api/todo/order", status_code=204)
    async def todo_order(request: Request) -> None:
        account = await writer(request)
        body = await json_body(request)
        await todo.reorder_items(
            account.account_id, body.get("day"), body.get("category_id"), body.get("ids")
        )

    # ------------------------------------------------------------ 카테고리 쓰기

    @app.post("/api/todo/categories")
    async def todo_category_add(request: Request) -> dict[str, Any]:
        account = await writer(request)
        return await todo.create_category(account.account_id, await json_body(request))

    @app.put("/api/todo/categories/order")
    async def todo_category_order(request: Request) -> dict[str, Any]:
        account = await writer(request)
        body = await json_body(request)
        rows = await todo.reorder_categories(account.account_id, body.get("ids"))
        return {"categories": rows}

    @app.patch("/api/todo/categories/{category_id}")
    async def todo_category_update(category_id: str, request: Request) -> dict[str, Any]:
        account = await writer(request)
        return await todo.update_category(
            account.account_id, parse_id(category_id), await json_body(request)
        )

    @app.delete("/api/todo/categories/{category_id}", status_code=204)
    async def todo_category_delete(category_id: str, request: Request) -> None:
        account = await writer(request)
        await todo.delete_category(account.account_id, parse_id(category_id))

    return todo_account

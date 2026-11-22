"""AI 연결로 하는 조심해야 하는 일(2026-11-22 사용자 결정).

- 지우기, 카테고리 만들기/바꾸기/끝내기: AI가 먼저 요청을 만들면 확인 번호와 요약이 나온다.
  사용자가 대화에서 '네'라고 한 뒤 AI가 confirm_action을 불러야 실행된다(10분 안).
- 공개 범위를 넓히거나 메모 공개를 켜는 것: 대화 확인에 더해 ㅁㅇㅅ 화면에서 사용자가 승인해야
  적용된다(남에게 보이는 범위는 되돌려도 이미 보였을 수 있어서). 좁히는 쪽은 대화 확인만.
- AI가 지운 TODO는 휴지통에 7일(ㅁㅇㅅ 화면에서 되돌리기).
- ㅁㅇㅅ 메시지, 디스코드 정보는 여전히 주지 않는다.
"""

from __future__ import annotations

import json
import secrets
import time
from collections.abc import Callable
from typing import Any

from mos.db.database import Database
from mos.db.todo_repo import TodoRepo
from mos.services.todo import TodoError, TodoService
from mos.services.todo_oauth import Grant
from mos.services.todo_trash_view import describe_bundle, describe_item

CHAT_TTL_SEC = 10 * 60
APP_TTL_SEC = 3 * 86400
TRASH_KEEP_SEC = 7 * 86400
MAX_DELETE = 20
VISIBILITY_RANK = {"private": 0, "selected": 1, "friends": 2, "public": 3}
VISIBILITY_WORD = {"private": "나만", "selected": "일부", "friends": "친구", "public": "전체"}
# 친구 일(2026-11-22 사용자 결정): 대화에서 확인한 뒤에도 ㅁㅇㅅ 화면에서 한 번 더 승인해야 실행
FRIEND_KINDS = (
    "friend_request",
    "friend_accept",
    "friend_remove",
    "group_create",
    "group_update",
    "group_delete",
    "set_audience",
    "block",
    "unblock",
)
# 반복 화면 일(2026-11-22 사용자 요청 'AI로도'): 대화에서 확인하면 실행
REPEAT_KINDS = ("repeat_create", "repeat_period", "repeat_update", "repeat_end", "repeat_delete")
KINDS = (
    "delete_todos",
    "add_category",
    "update_category",
    "close_category",
    *FRIEND_KINDS,
    *REPEAT_KINDS,
)


class ActionError(Exception):
    """AI에게 그대로 보여 줄 문장."""


class TodoAiActions:
    def __init__(
        self,
        db: Database,
        todo: TodoService,
        repo: TodoRepo,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.db = db
        self.todo = todo
        self.repo = repo
        self.clock = clock
        self.friends: Any = None  # TodoFriends(앱이 이어 줌, 친구 일 실행용)
        self.bin: Any = None  # TodoBin(앱이 이어 줌, 카테고리, 반복, 그룹 묶음 되살리기)

    def now(self) -> int:
        return int(self.clock())

    # ------------------------------------------------------------ 요청 만들기(대화 확인 전)

    async def request(self, grant: Grant, kind: str, payload: dict[str, Any], summary: str) -> str:
        if kind not in KINDS:
            raise ActionError("없는 요청이에요")
        action_id = secrets.token_urlsafe(9)
        now = self.now()
        async with self.db.writing() as conn:
            await conn.execute("DELETE FROM todo_ai_action WHERE expires_at < ?", (now,))
            await conn.execute(
                "INSERT INTO todo_ai_action (id, account_id, grant_id, kind, payload, summary,"
                " state, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, 'chat', ?, ?)",
                (
                    action_id,
                    grant.account_id,
                    grant.id,
                    kind,
                    json.dumps(payload),
                    summary,
                    now,
                    now + CHAT_TTL_SEC,
                ),
            )
        return action_id

    async def _take(self, account_id: int, action_id: Any, state: str, grant_id: int | None):
        if not isinstance(action_id, str) or not 4 <= len(action_id) <= 40:
            return None
        row = await self.db.fetch_one(
            "SELECT kind, payload, summary, grant_id, expires_at FROM todo_ai_action"
            " WHERE id = ? AND account_id = ? AND state = ?",
            (action_id, account_id, state),
        )
        if row is None or int(row[4]) < self.now():
            return None
        if grant_id is not None and int(row[3]) != grant_id:
            return None
        return {"kind": str(row[0]), "payload": json.loads(row[1]), "summary": str(row[2])}

    async def _forget(self, action_id: str) -> None:
        async with self.db.writing() as conn:
            await conn.execute("DELETE FROM todo_ai_action WHERE id = ?", (action_id,))

    # ------------------------------------------------------------ 대화에서 확인받은 뒤

    async def confirm(self, grant: Grant, action_id: Any) -> str:
        found = await self._take(grant.account_id, action_id, "chat", grant.id)
        if found is None:
            raise ActionError("확인 번호가 없거나 10분이 지났어요. 다시 요청해 주세요.")
        account_id = grant.account_id
        kind, payload = found["kind"], found["payload"]
        if kind in FRIEND_KINDS or (
            kind == "update_category" and await self._widens(account_id, payload)
        ):
            # 남에게 보이는 범위를 넓히는 것은 ㅁㅇㅅ 화면에서 한 번 더
            async with self.db.writing() as conn:
                await conn.execute(
                    "UPDATE todo_ai_action SET state = 'app', expires_at = ? WHERE id = ?",
                    (self.now() + APP_TTL_SEC, action_id),
                )
            await self.repo.add_news(
                account_id,
                "ai_request",
                f"{grant.client_name}의 승인 요청",
                found["summary"],
                self.now(),
            )
            return (
                "친구나 공개 범위에 관한 일이라 ㅁㅇㅅ 화면(TODO › AI)에서 사용자가 승인해야 "
                "적용돼요. 사용자에게 ㅁㅇㅅ에서 승인해 달라고 알려 주세요."
            )
        await self._forget(str(action_id))
        return await self._run(account_id, kind, payload, grant.client_name)

    async def _widens(self, account_id: int, payload: dict[str, Any]) -> bool:
        changes = payload.get("changes", {})
        row = await self.repo.category(account_id, int(payload["category_id"]))
        if row is None:
            return False
        if "visibility" in changes and VISIBILITY_RANK.get(
            changes["visibility"], 0
        ) > VISIBILITY_RANK.get(row["visibility"], 0):
            return True
        return changes.get("memo_shared") is True and not row["memo_shared"]

    async def _run(self, account_id: int, kind: str, payload: dict[str, Any], client: str) -> str:
        try:
            if kind == "delete_todos":
                count = 0
                for item_id in payload["ids"]:
                    if await self.trash_item(account_id, item_id, client):
                        count += 1
                return (
                    f"{count}개를 지웠어요. "
                    "ㅁㅇㅅ 휴지통(TODO › 카테고리 화면 맨 아래, 또는 TODO › AI)에서 "
                    "7일 동안 되돌릴 수 있어요."
                )
            if kind == "add_category":
                made = await self.todo.create_category(account_id, payload)
                return f"'{made['name']}' 카테고리를 만들었어요."
            if kind == "update_category":
                made = await self.todo.update_category(
                    account_id, int(payload["category_id"]), payload["changes"]
                )
                return f"'{made['name']}' 카테고리를 바꿨어요."
            if kind == "close_category":
                made = await self.todo.update_category(
                    account_id, int(payload["category_id"]), {"closed": True}
                )
                return (
                    f"'{made['name']}' 카테고리를 끝냈어요(지운 게 아니라 숨김, "
                    "ㅁㅇㅅ 카테고리 화면에서 다시 열 수 있어요)."
                )
            if kind in FRIEND_KINDS and self.friends is not None:
                return await self._run_friend(account_id, kind, payload)
            if kind in REPEAT_KINDS:
                return await self._run_repeat(account_id, kind, payload)
        except TodoError as error:
            raise ActionError(_todo_error(error)) from error
        raise ActionError("없는 요청이에요")

    async def _run_repeat(self, account_id: int, kind: str, payload: dict[str, Any]) -> str:
        if kind == "repeat_create":
            made = await self.todo.new_repeat(account_id, payload)
            return f"'{made['title']}' 반복을 만들었어요."
        if kind == "repeat_period":
            await self.todo.new_repeat(account_id, payload)
            return "반복에 새 기간을 더했어요."
        if kind == "repeat_update":
            await self.todo.update_repeat(account_id, int(payload["repeat_id"]), payload["changes"])
            return "반복을 바꿨어요."
        if kind == "repeat_end":
            await self.todo.end_repeat(account_id, payload["series_id"], payload["today"])
            return "반복을 오늘까지로 끝냈어요. 앞으로 생길 회차는 지우고 지난 것은 남겼어요."
        if not await self.todo.delete_repeat_series(
            account_id, payload["series_id"], payload["today"]
        ):
            raise ActionError("그런 반복이 없어요")
        return (
            "반복을 지웠어요. 지난 회차는 따로 남겼고, ㅁㅇㅅ 휴지통(카테고리 화면 맨 아래)에서 "
            "7일 동안 되살릴 수 있어요."
        )

    async def _run_friend(self, account_id: int, kind: str, payload: dict[str, Any]) -> str:
        friends = self.friends
        if kind == "block":
            await friends.block(account_id, payload["person"])
            return "차단했어요. 서로 TODO가 안 보이고 친구도 끊겼어요."
        if kind == "unblock":
            await friends.unblock(account_id, payload["person"])
            return "차단을 풀었어요."
        if kind == "friend_request":
            state = await friends.request(account_id, payload["person"])
            return "친구가 됐어요." if state == "friends" else "친구 요청을 보냈어요."
        if kind == "friend_accept":
            await friends.accept(account_id, payload["person"])
            return "친구 요청을 받았어요."
        if kind == "friend_remove":
            await friends.remove(account_id, payload["person"])
            return "친구를 끊었어요(요청이었으면 취소, 거절)."
        if kind == "group_create":
            made = await friends.create_group(
                account_id, {"name": payload["name"], "members": payload.get("members", [])}
            )
            return f"'{made['name']}' 그룹을 만들었어요."
        if kind == "group_update":
            if "name" in payload:
                await friends.rename_group(account_id, payload["group"], payload["name"])
            if "members" in payload:
                await friends.set_members(account_id, payload["group"], payload["members"])
            return "그룹을 바꿨어요."
        if kind == "group_delete":
            await friends.delete_group(account_id, payload["group"])
            return "그룹을 지웠어요."
        await friends.set_audience(
            account_id,
            payload["category"],
            {"friends": payload.get("friends", []), "groups": payload.get("groups", [])},
        )
        if payload.get("visibility"):
            await self.todo.update_category(
                account_id, int(payload["category"]), {"visibility": payload["visibility"]}
            )
        return "일부 공개 대상을 바꿨어요."

    async def trash_item(self, account_id: int, item_id: Any, client: str = "") -> bool:
        """TODO를 지우고 휴지통에 7일(앱에서 지울 때 client는 빈 문자열)."""
        try:
            row = await self.todo._row(account_id, item_id)  # noqa: SLF001  반복 회차도 행으로
        except TodoError:
            return False
        now = self.now()
        if row["repeat_id"] is None:
            snapshot = {
                key: row[key]
                for key in ("category_id", "title", "memo", "day", "time", "place", "done_at")
            }
            snapshot["source"] = row["source"]
            kind, keep_id = "item", None
            await self.repo.delete_item(account_id, row["id"])
        else:
            snapshot = {}
            kind, keep_id = "skip", row["id"]
            await self.repo.update_item(account_id, row["id"], {"skipped": 1}, now)
        async with self.db.writing() as conn:
            await conn.execute(
                "DELETE FROM todo_trash WHERE deleted_at < ?", (now - TRASH_KEEP_SEC,)
            )
            await conn.execute(
                "INSERT INTO todo_trash (account_id, kind, item_id, payload, label, day,"
                " client_name, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    account_id,
                    kind,
                    keep_id,
                    json.dumps(snapshot),
                    row["title"],
                    row["day"],
                    client,
                    now,
                ),
            )
        return True

    # ------------------------------------------------------------ ㅁㅇㅅ 화면: 승인 기다리는 요청

    async def pending(self, account_id: int) -> list[dict[str, Any]]:
        rows = await self.db.fetch_all(
            "SELECT a.id, a.summary, a.created_at, c.name FROM todo_ai_action a"
            " JOIN oauth_grant g ON g.id = a.grant_id JOIN oauth_client c ON c.id = g.client_id"
            " WHERE a.account_id = ? AND a.state = 'app' AND a.expires_at >= ?"
            " ORDER BY a.created_at DESC",
            (account_id, self.now()),
        )
        return [
            {"id": str(r[0]), "summary": str(r[1]), "created_at": int(r[2]), "client": str(r[3])}
            for r in rows
        ]

    async def decide(self, account_id: int, action_id: Any, approve: bool) -> str | None:
        found = await self._take(account_id, action_id, "app", None)
        if found is None:
            return None
        await self._forget(str(action_id))
        if not approve:
            return "거절했어요."
        try:
            return await self._run(account_id, found["kind"], found["payload"], "")
        except ActionError as error:
            return str(error)

    # ------------------------------------------------------------ 휴지통

    async def trash(self, account_id: int) -> list[dict[str, Any]]:
        rows = await self.db.fetch_all(
            "SELECT id, label, day, client_name, deleted_at, kind, item_id, payload FROM todo_trash"
            " WHERE account_id = ? AND deleted_at >= ? ORDER BY id DESC LIMIT 100",
            (account_id, self.now() - TRASH_KEEP_SEC),
        )
        names = {
            str(row[0]): str(row[1])
            for row in await self.db.fetch_all(
                "SELECT id, name FROM todo_category WHERE account_id = ?", (account_id,)
            )
        }
        out = []
        for r in rows:
            try:
                payload = json.loads(r[7])
            except ValueError:
                payload = {}
            if r[5] == "bundle":
                details = describe_bundle(payload if isinstance(payload, dict) else {})
            else:
                snapshot = payload if isinstance(payload, dict) and payload else {}
                if r[5] == "skip" and r[6] is not None:
                    found = await self.repo.item(account_id, int(r[6]))
                    snapshot = dict(found) if found is not None else {}
                    snapshot.setdefault("day", r[2])
                details = describe_item(
                    snapshot or {"day": r[2]}, names.get(str(snapshot.get("category_id")), "")
                )
                if r[5] == "skip":
                    details[0]["rows"].insert(0, "반복에서 이 날만 뺀 것")
            out.append(
                {
                    "id": str(r[0]),
                    "title": str(r[1]),
                    "day": str(r[2]),
                    "client": str(r[3]),
                    "deleted_at": int(r[4]),
                    "kind": "item" if r[5] in ("item", "skip") else "bundle",
                    "details": details,
                }
            )
        return out

    async def purge(self, account_id: int, trash_id: Any) -> bool:
        """휴지통에서 영구 삭제. 되살릴 내용만 지우면 된다(원래 것은 이미 지워졌다)."""
        if not isinstance(trash_id, str) or not trash_id.isdigit() or len(trash_id) > 18:
            return False
        async with self.db.writing() as conn:
            cursor = await conn.execute(
                "DELETE FROM todo_trash WHERE id = ? AND account_id = ?",
                (int(trash_id), account_id),
            )
            return (cursor.rowcount or 0) > 0

    async def restore(self, account_id: int, trash_id: Any) -> bool:
        if not isinstance(trash_id, str) or not trash_id.isdigit() or len(trash_id) > 18:
            return False
        row = await self.db.fetch_one(
            "SELECT kind, item_id, payload FROM todo_trash"
            " WHERE id = ? AND account_id = ? AND deleted_at >= ?",
            (int(trash_id), account_id, self.now() - TRASH_KEEP_SEC),
        )
        if row is None:
            return False
        if row[0] == "bundle":
            if self.bin is None:
                return False
            await self.bin.restore(account_id, json.loads(row[2]))
        elif row[0] == "skip":
            if row[1] is not None and await self.repo.item(account_id, int(row[1])):
                await self.repo.update_item(account_id, int(row[1]), {"skipped": 0}, self.now())
        else:
            values = json.loads(row[2])
            open_ids = [
                c["id"] for c in await self.todo.categories(account_id) if c["closed_at"] is None
            ]
            if values["category_id"] not in open_ids:
                values["category_id"] = open_ids[0]  # 카테고리가 끝났거나 없어졌으면 첫 카테고리로
            await self.repo.add_item(account_id, values, self.now())
        async with self.db.writing() as conn:
            await conn.execute("DELETE FROM todo_trash WHERE id = ?", (int(trash_id),))
        return True


def _todo_error(error: TodoError) -> str:
    words = {
        "bad_name": "카테고리 이름은 1~20자예요",
        "duplicate_name": "같은 이름의 카테고리가 있어요",
        "too_many_categories": "카테고리는 50개까지예요",
        "last_category": "열린 카테고리가 하나는 있어야 해요",
        "bad_color": "색은 #RRGGBB여야 해요",
        "bad_visibility": "공개 범위는 나만, 일부, 친구, 전체 중 하나예요",
        "not_found": "그런 TODO, 카테고리, 사람, 그룹이 없어요",
        "not_friend": "친구만 고를 수 있어요",
        "too_many_groups": "그룹은 30개까지예요",
        "too_many_friends": "친구는 200명까지예요",
        "period_overlap": "새 기간은 앞 기간이 끝난 다음 날부터 시작해야 해요",
        "bad_rule": "반복 규칙은 daily, weekdays, weekends, weekly 중 하나예요",
        "bad_weekdays": "매주 반복은 요일을 하나 이상 골라야 해요",
        "bad_end_day": "마지막 날은 시작 날보다 뒤여야 해요",
        "bad_day": "날짜는 YYYY-MM-DD여야 해요",
        "bad_time": "시각은 HH:MM(24시간)이어야 해요",
        "bad_title": "이름은 1~100자 한 줄이어야 해요",
        "too_many_repeats": "반복은 100개까지예요",
    }
    return words.get(error.code, "처리하지 못했어요")


def visibility_word(value: str) -> str:
    return VISIBILITY_WORD.get(value, value)

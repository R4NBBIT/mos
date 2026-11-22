"""할 일 친구, 공개 범위, 반응(T4: FRIEND, VIS, REACT, NOTI-02).

- 친구: 같은 디스코드 서버(봇이 있고 둘 다 지금 멤버인 서버)의 할 일 사용자에게만 요청.
  초대 링크, 아이디, 공개 프로필 없음. '친구 요청 받기'를 끄면 찾기 목록에 안 나오고 요청도 못 받음.
- 보기: 친구는 '전체'와 '친구' 카테고리, 같은 서버 사용자는 '전체' 카테고리만. '나만'은 아무도.
  메모는 그 카테고리가 '메모도 보여 주기'일 때만(아니면 메모가 있다는 표시도 없음).
  끝낸 카테고리는 안 보임.
- 반응: 볼 수 있는 할 일에만. 유니코드 이모지 또는 반응하는 사람이 쓸 수 있는 디스코드 이모지.
- 소식: 친구 요청, 수락, 반응(같은 사람이 1분 안에 한 반응은 하나로).
"""

from __future__ import annotations

import re
import time
import unicodedata
from collections.abc import Awaitable, Callable
from typing import Any

from mos.db.database import Database
from mos.db.todo_repo import TodoRepo
from mos.services.todo import TodoError, TodoService
from mos.services.todo_access import TodoAccess

MAX_FRIENDS = 200
MAX_PENDING_OUT = 20
MAX_EMOJI_PER_PERSON = 10
REACTION_MERGE_SEC = 60
CUSTOM_EMOJI = re.compile(r"^<(a?):([A-Za-z0-9_]{1,32}):(\d{15,21})>$")
SHOWN_TO = {
    "friend": ("public", "friends"),
    "server": ("public",),
    "self": ("public", "friends", "private"),
}

# (디스코드 사용자 ID) → 지금 같이 있는 서버 ID들
GuildsOf = Callable[[int], Awaitable[set[int]]]
# (디스코드 사용자 ID, 니트로) → 쓸 수 있는 디스코드 이모지 코드들
EmojisOf = Callable[[int, bool], Awaitable[set[str]]]
# (계정 ID, 제목, 본문) → 알림 보내기(탭, 웹 푸시)
Notify = Callable[[int, str, str], Awaitable[None]]


def check_unicode_emoji(value: str) -> bool:
    """유니코드 이모지 하나(합친 이모지, 피부색, 국기 포함). 글자, 숫자, 꺾쇠 같은 것은 안 됨."""
    if not 1 <= len(value) <= 16 or value.strip() != value:
        return False
    has_symbol = False
    for char in value:
        code = ord(char)
        if char in "‍️︎⃣" or 0x1F3FB <= code <= 0x1F3FF or 0xE0020 <= code <= 0xE007F:
            continue  # 잇기, 모양 고르기, 피부색, 태그
        category = unicodedata.category(char)
        if category in ("So", "Sk") or 0x1F1E6 <= code <= 0x1F1FF:
            has_symbol = True
            continue
        if char in "#*0123456789":
            continue  # 키캡(#️⃣ 1️⃣)의 앞 글자
        return False
    return has_symbol


class TodoFriends:
    def __init__(
        self,
        db: Database,
        todo: TodoService,
        repo: TodoRepo,
        access: TodoAccess,
        guilds_of: GuildsOf,
        emojis_of: EmojisOf,
        notify: Notify | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.db = db
        self.todo = todo
        self.repo = repo
        self.access = access
        self.guilds_of = guilds_of
        self.emojis_of = emojis_of
        self.notify = notify
        self.clock = clock

    def now(self) -> int:
        return int(self.clock())

    # ------------------------------------------------------------ 사람

    async def _account(self, account_id: int) -> dict[str, Any] | None:
        row = await self.db.fetch_one(
            "SELECT id, discord_user_id, name, avatar_url, premium_type FROM account"
            " WHERE id = ? AND status = 'active'",
            (account_id,),
        )
        if row is None or not self.access.allowed(int(row[1])):
            return None
        return {
            "id": int(row[0]),
            "user_id": int(row[1]),
            "name": str(row[2]),
            "avatar_url": row[3],
            "premium": int(row[4]) > 0,
        }

    @staticmethod
    def _person(account: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": str(account["id"]),
            "name": account["name"],
            "avatar_url": account["avatar_url"],
        }

    async def _share_guild(self, one: dict[str, Any], other: dict[str, Any]) -> bool:
        return bool(await self.guilds_of(one["user_id"]) & await self.guilds_of(other["user_id"]))

    async def _pair(self, me: int, other: int) -> dict[str, Any] | None:
        a, b = min(me, other), max(me, other)
        row = await self.db.fetch_one(
            "SELECT requester, status FROM todo_friend WHERE account_a = ? AND account_b = ?",
            (a, b),
        )
        return {"requester": int(row[0]), "status": str(row[1])} if row else None

    async def relation(self, viewer: int, owner: int) -> str | None:
        """self, friend, server(같은 서버 할 일 사용자), 또는 None(볼 수 없음)."""
        if viewer == owner:
            return "self"
        me, them = await self._account(viewer), await self._account(owner)
        if me is None or them is None or not await self._share_guild(me, them):
            return None
        pair = await self._pair(viewer, owner)
        return "friend" if pair and pair["status"] == "accepted" else "server"

    async def accepts_requests(self, account_id: int) -> bool:
        return (await self.todo.raw_prefs(account_id)).get("accept_requests") is not False

    async def people(self, me_id: int) -> dict[str, Any]:
        me = await self._account(me_id)
        if me is None:
            raise TodoError("not_found", 404)
        rows = await self.db.fetch_all(
            "SELECT account_a, account_b, requester, status FROM todo_friend"
            " WHERE account_a = ? OR account_b = ?",
            (me_id, me_id),
        )
        related: dict[int, tuple[int, str]] = {}
        for a, b, requester, status in rows:
            other = int(b) if int(a) == me_id else int(a)
            related[other] = (int(requester), str(status))
        friends, incoming, outgoing = [], [], []
        for other_id, (requester, status) in related.items():
            other = await self._account(other_id)
            if other is None:
                continue
            if status == "accepted":
                friends.append(self._person(other))
            elif requester == me_id:
                outgoing.append(self._person(other))
            else:
                incoming.append(self._person(other))
        mine = await self.guilds_of(me["user_id"])
        candidates = []
        account_rows = await self.db.fetch_all(
            "SELECT id FROM account WHERE status = 'active' AND id != ?", (me_id,)
        )
        for (other_id,) in account_rows:
            if int(other_id) in related:
                continue
            other = await self._account(int(other_id))
            if other is None or not await self.accepts_requests(other["id"]):
                continue
            if mine & await self.guilds_of(other["user_id"]):
                candidates.append(self._person(other))
        by_name = lambda person: person["name"].casefold()  # noqa: E731
        return {
            "friends": sorted(friends, key=by_name),
            "incoming": sorted(incoming, key=by_name),
            "outgoing": sorted(outgoing, key=by_name),
            "candidates": sorted(candidates, key=by_name),
            "accept_requests": await self.accepts_requests(me_id),
        }

    # ------------------------------------------------------------ 요청, 수락, 끊기

    async def request(self, me_id: int, raw_other: Any) -> str:
        other_id = _account_id(raw_other)
        me, other = await self._account(me_id), await self._account(other_id)
        if me is None or other is None or other_id == me_id:
            raise TodoError("not_found", 404)
        if not await self._share_guild(me, other):
            raise TodoError("not_found", 404)  # 같은 서버가 아니면 없는 사람과 같게
        pair = await self._pair(me_id, other_id)
        if pair is not None:
            if pair["status"] == "accepted":
                return "friends"
            if pair["requester"] == other_id:
                return await self.accept(me_id, str(other_id))  # 서로 요청하면 바로 친구
            return "pending"
        if not await self.accepts_requests(other_id):
            raise TodoError("not_found", 404)
        out = await self.db.fetch_one(
            "SELECT COUNT(*) FROM todo_friend WHERE requester = ? AND status = 'pending'",
            (me_id,),
        )
        if out and int(out[0]) >= MAX_PENDING_OUT:
            raise TodoError("too_many_requests", 409)
        await self._check_friend_limit(me_id)
        async with self.db.writing() as conn:
            await conn.execute(
                "INSERT INTO todo_friend (account_a, account_b, requester, status, created_at)"
                " VALUES (?, ?, ?, 'pending', ?)",
                (min(me_id, other_id), max(me_id, other_id), me_id, self.now()),
            )
        await self._tell(
            other_id, "friend_request", "친구 요청", f"{me['name']}님이 친구 요청을 보냈어요"
        )
        return "pending"

    async def _check_friend_limit(self, account_id: int) -> None:
        row = await self.db.fetch_one(
            "SELECT COUNT(*) FROM todo_friend WHERE (account_a = ? OR account_b = ?)"
            " AND status = 'accepted'",
            (account_id, account_id),
        )
        if row and int(row[0]) >= MAX_FRIENDS:
            raise TodoError("too_many_friends", 409)

    async def accept(self, me_id: int, raw_other: Any) -> str:
        other_id = _account_id(raw_other)
        pair = await self._pair(me_id, other_id)
        if pair is None or pair["status"] != "pending" or pair["requester"] != other_id:
            raise TodoError("not_found", 404)
        me = await self._account(me_id)
        if me is None or await self._account(other_id) is None:
            raise TodoError("not_found", 404)
        await self._check_friend_limit(me_id)
        await self._check_friend_limit(other_id)
        async with self.db.writing() as conn:
            await conn.execute(
                "UPDATE todo_friend SET status = 'accepted', accepted_at = ?"
                " WHERE account_a = ? AND account_b = ?",
                (self.now(), min(me_id, other_id), max(me_id, other_id)),
            )
        await self._tell(
            other_id, "friend_accept", "친구가 됐어요", f"{me['name']}님이 친구 요청을 받았어요"
        )
        return "friends"

    async def remove(self, me_id: int, raw_other: Any) -> None:
        """요청 취소, 거절, 친구 끊기 모두(상대에게 알리지 않음)."""
        other_id = _account_id(raw_other)
        async with self.db.writing() as conn:
            await conn.execute(
                "DELETE FROM todo_friend WHERE account_a = ? AND account_b = ?",
                (min(me_id, other_id), max(me_id, other_id)),
            )
            # 서로 볼 수 없게 됐을 수 있으니 남긴 반응은 그대로 두되, 보이는 곳에서만 보인다

    async def set_accept_requests(self, me_id: int, value: Any) -> None:
        if not isinstance(value, bool):
            raise TodoError("bad_body")
        await self.todo.save_raw_prefs(me_id, {"accept_requests": value})

    # ------------------------------------------------------------ 보기

    async def _visible(self, viewer: int, owner: int) -> tuple[str, list[dict[str, Any]]]:
        relation = await self.relation(viewer, owner)
        if relation is None:
            raise TodoError("not_found", 404)
        rows = await self.todo.categories(owner)
        shown = SHOWN_TO[relation]
        return relation, [
            row for row in rows if row["visibility"] in shown and row["closed_at"] is None
        ]

    async def day_for(self, viewer: int, raw_owner: Any, day: str) -> dict[str, Any]:
        owner = _account_id(raw_owner)
        relation, categories = await self._visible(viewer, owner)
        data = await self.todo.day(owner, day)
        allowed = {str(row["id"]): row for row in categories}
        items = []
        for item in data["items"]:
            category = allowed.get(item["category_id"])
            if category is None:
                continue
            shown = dict(item)
            if not category["memo_shared"] and relation != "self":
                shown["memo"] = ""
            shown.pop("source", None)
            items.append(shown)
        await self.annotate(viewer, owner, items)
        person = await self._account(owner)
        return {
            "day": data["day"],
            "relation": relation,
            "person": self._person(person) if person else None,
            "categories": [c for c in data["categories"] if c["id"] in allowed],
            "items": items,
        }

    async def friends_today(self, me_id: int, day: str) -> list[dict[str, Any]]:
        """'나와 친구' 목록: 친구마다 내가 볼 수 있는 할 일의 한 수/전체."""
        people = (await self.people(me_id))["friends"]
        result = []
        for person in people:
            try:
                data = await self.day_for(me_id, person["id"], day)
            except TodoError:
                continue
            done = sum(1 for item in data["items"] if item["done"])
            result.append({**person, "done": done, "total": len(data["items"])})
        return result

    # ------------------------------------------------------------ 반응

    async def annotate(self, viewer: int, owner: int, items: list[dict[str, Any]]) -> None:
        ids = [int(item["id"]) for item in items if str(item["id"]).isdigit()]
        found: dict[str, list[dict[str, Any]]] = {}
        if ids:
            marks = ",".join("?" * len(ids))
            rows = await self.db.fetch_all(
                f"SELECT item_id, emoji, COUNT(*), SUM(reactor_account = ?), MIN(created_at)"  # noqa: S608
                f" FROM todo_reaction WHERE owner_account = ? AND item_id IN ({marks})"
                " GROUP BY item_id, emoji ORDER BY MIN(created_at), MIN(rowid)",
                (viewer, owner, *ids),
            )
            for item_id, emoji, count, mine, _first in rows:
                found.setdefault(str(item_id), []).append(
                    {"emoji": str(emoji), "count": int(count), "mine": bool(mine)}
                )
        for item in items:
            item["reactions"] = found.get(str(item["id"]), [])

    async def react(
        self, viewer: int, raw_owner: Any, raw_item: Any, emoji: Any, on: Any
    ) -> list[dict[str, Any]]:
        owner = _account_id(raw_owner)
        if not isinstance(on, bool) or not isinstance(emoji, str):
            raise TodoError("bad_body")
        relation, categories = await self._visible(viewer, owner)
        allowed = {row["id"] for row in categories}
        viewer_account = await self._account(viewer)
        if viewer_account is None:
            raise TodoError("not_found", 404)
        custom = CUSTOM_EMOJI.match(emoji)
        if on:
            if custom:
                usable = await self.emojis_of(viewer_account["user_id"], viewer_account["premium"])
                if emoji not in usable:
                    raise TodoError("bad_emoji")
            elif not check_unicode_emoji(emoji):
                raise TodoError("bad_emoji")
        row = await self.todo.row_for_reaction(owner, raw_item, materialize=on)
        if row is None or row["category_id"] not in allowed:
            raise TodoError("not_found", 404)
        now = self.now()
        async with self.db.writing() as conn:
            if on:
                async with conn.execute(
                    "SELECT COUNT(*) FROM todo_reaction WHERE item_id = ? AND reactor_account = ?",
                    (row["id"], viewer),
                ) as cursor:
                    (count,) = await cursor.fetchone()
                if int(count) >= MAX_EMOJI_PER_PERSON:
                    raise TodoError("too_many_reactions", 409)
                cursor = await conn.execute(
                    "INSERT OR IGNORE INTO todo_reaction (item_id, owner_account, reactor_account,"
                    " emoji, created_at) VALUES (?, ?, ?, ?, ?)",
                    (row["id"], owner, viewer, emoji, now),
                )
                added = cursor.rowcount == 1
            else:
                await conn.execute(
                    "DELETE FROM todo_reaction WHERE item_id = ? AND reactor_account = ?"
                    " AND emoji = ?",
                    (row["id"], viewer, emoji),
                )
                added = False
        if added and viewer != owner:
            shown = emoji if not custom else f":{custom.group(2)}:"
            await self._tell_reaction(owner, viewer_account["name"], row["title"], shown)
        result = [{"id": str(row["id"])}]
        await self.annotate(viewer, owner, result)
        return result[0]["reactions"]

    # ------------------------------------------------------------ 소식

    async def _tell(self, account_id: int, kind: str, title: str, body: str) -> None:
        await self.repo.add_news(account_id, kind, title, body, self.now())
        if self.notify is not None:
            await self.notify(account_id, title, body)

    async def _tell_reaction(self, owner: int, name: str, title: str, emoji: str) -> None:
        """같은 사람의 반응은 1분 안이면 소식 하나로 합친다(알림도 처음 한 번만)."""
        head = f"{name}님의 반응"
        last = await self.db.fetch_one(
            "SELECT id, body, created_at FROM todo_news WHERE account_id = ? AND kind = 'reaction'"
            " AND title = ? ORDER BY id DESC LIMIT 1",
            (owner, head),
        )
        if last is not None and int(last[2]) >= self.now() - REACTION_MERGE_SEC:
            body = f"{last[1]} {emoji}"[:300]
            async with self.db.writing() as conn:
                await conn.execute("UPDATE todo_news SET body = ? WHERE id = ?", (body, last[0]))
            return
        await self._tell(owner, "reaction", head, f"'{title}'에 {emoji}")


def _account_id(raw: Any) -> int:
    if isinstance(raw, int) and not isinstance(raw, bool):
        return raw
    if isinstance(raw, str) and raw.isdigit() and len(raw) <= 18:
        return int(raw)
    raise TodoError("not_found", 404)

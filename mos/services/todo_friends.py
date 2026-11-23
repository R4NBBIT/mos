"""TODO 친구, 공개 범위, 반응(T4: FRIEND, VIS, REACT, NOTI-02).

- 친구: 같은 디스코드 서버(봇이 있고 둘 다 지금 멤버인 서버)의 TODO 사용자에게만 요청.
  초대 링크, 아이디, 공개 프로필 없음. '친구 요청 받기'를 끄면 찾기 목록에 안 나오고 요청도 못 받음.
- 보기: 친구는 '전체'와 '친구' 카테고리, 같은 서버 사용자는 '전체' 카테고리만. '나만'은 아무도.
  메모는 그 카테고리가 '메모도 보여 주기'일 때만(아니면 메모가 있다는 표시도 없음).
  끝낸 카테고리는 안 보임.
- 반응: 볼 수 있는 TODO에만. 유니코드 이모지 또는 반응하는 사람이 쓸 수 있는 디스코드 이모지.
- 소식: 친구 요청, 수락, 반응(같은 사람이 1분 안에 한 반응은 하나로).
"""

from __future__ import annotations

import logging
import re
import time
import unicodedata
from collections.abc import Awaitable, Callable
from typing import Any

from mos.db.database import Database
from mos.db.todo_repo import TodoRepo
from mos.services.discord_oauth import clean_username
from mos.services.todo import TodoError, TodoService
from mos.services.todo_access import TodoAccess

MAX_FRIENDS = 200
MAX_EMOJI_PER_PERSON = 10
REACTION_MERGE_SEC = 60
CUSTOM_EMOJI = re.compile(r"^<(a?):([A-Za-z0-9_]{1,32}):(\d{15,21})>$")
MAX_GROUPS = 30
MAX_GROUP_NAME = 20

# (디스코드 사용자 ID) → 지금 같이 있는 서버 ID들
log = logging.getLogger(__name__)

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


# (디스코드 사용자 ID, 같이 있는 서버들) → 디스코드 아이디(사용자명) 또는 None
UsernameOf = Callable[[int, set[int]], Awaitable[str | None]]
SEARCH_LIMIT = 20  # 아이디 찾기: 1분에 20번까지(아이디를 하나씩 넣어 보며 사람을 캐지 못하게)
SEARCH_WINDOW = 60
BACKFILL_MAX = 30  # 한 번 찾을 때 아이디를 채우는 예전 계정 수


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
        username_of: UsernameOf | None = None,
    ) -> None:
        self.username_of = username_of  # 예전 계정의 디스코드 아이디 채우기(봇이 멤버 정보로)
        self._searches: dict[int, list[float]] = {}
        self._tried: set[int] = (
            set()
        )  # 봇이 아이디를 못 찾은 계정(다시 묻지 않음, 다시 시작하면 다시)
        self.bin: Any = None  # TodoBin(앱이 이어 줌): 그룹 지우기도 휴지통으로
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

    async def blocked(self, one: int, other: int) -> bool:
        """둘 중 한쪽이라도 차단했는지."""
        row = await self.db.fetch_one(
            "SELECT 1 FROM todo_block WHERE (account_id = ? AND blocked_account = ?)"
            " OR (account_id = ? AND blocked_account = ?)",
            (one, other, other, one),
        )
        return row is not None

    async def _block_set(self, me_id: int) -> tuple[set[int], set[int]]:
        """(내가 차단한 사람, 나를 차단한 사람)"""
        rows = await self.db.fetch_all(
            "SELECT account_id, blocked_account FROM todo_block"
            " WHERE account_id = ? OR blocked_account = ?",
            (me_id, me_id),
        )
        mine = {int(r[1]) for r in rows if int(r[0]) == me_id}
        theirs = {int(r[0]) for r in rows if int(r[1]) == me_id}
        return mine, theirs

    async def relation(self, viewer: int, owner: int) -> str | None:
        """self, friend, server(같은 서버 TODO 사용자), 또는 None(볼 수 없음, 차단 포함)."""
        if viewer == owner:
            return "self"
        if await self.blocked(viewer, owner):
            return None
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
        i_blocked, blocked_me = await self._block_set(me_id)
        hidden = i_blocked | blocked_me
        related: dict[int, tuple[int, str]] = {}
        for a, b, requester, status in rows:
            other = int(b) if int(a) == me_id else int(a)
            related[other] = (int(requester), str(status))
        friends, incoming, outgoing = [], [], []
        for other_id, (requester, status) in related.items():
            other = await self._account(other_id)
            if other is None or other_id in hidden:
                continue
            if status == "accepted":
                friends.append(self._person(other))
            elif requester == me_id:
                outgoing.append(self._person(other))
            else:
                incoming.append(self._person(other))
        by_name = lambda person: person["name"].casefold()  # noqa: E731
        return {
            "friends": sorted(friends, key=by_name),
            "incoming": sorted(incoming, key=by_name),
            "outgoing": sorted(outgoing, key=by_name),
            "blocked": sorted(
                [self._person(a) for a in [await self._account(i) for i in i_blocked] if a],
                key=by_name,
            ),
            "accept_requests": await self.accepts_requests(me_id),
        }

    # ------------------------------------------------------------ 디스코드 아이디로 찾기

    async def find(self, me_id: int, raw: Any) -> dict[str, Any]:
        """디스코드 아이디(사용자명)가 정확히 같은 사람 한 명(2026-11-23 사용자 요청:
        요청 가능한 사람 목록은 보여 주지 않고, 닉네임이 아니라 아이디로만 찾기).
        같은 서버가 아니거나, 비공개 사이거나, 요청을 안 받는 사람은 '없음'과 같게 답한다."""
        me = await self._account(me_id)
        if me is None:
            raise TodoError("not_found", 404)
        now = self.clock()
        recent = [at for at in self._searches.get(me_id, []) if now - at < SEARCH_WINDOW]
        if len(recent) >= SEARCH_LIMIT:
            raise TodoError("too_many", 429)
        self._searches[me_id] = [*recent, now]
        username = clean_username(str(raw or "").strip().lstrip("@"))
        if not username:
            raise TodoError("bad_username")
        await self._fill_usernames(me)
        row = await self.db.fetch_one(
            "SELECT id FROM account WHERE username = ? AND status = 'active' AND id != ?",
            (username, me_id),
        )
        other = await self._account(int(row[0])) if row else None
        if other is None or await self.blocked(me_id, other["id"]):
            raise TodoError("not_found", 404)
        if not await self._share_guild(me, other):
            raise TodoError("not_found", 404)
        pair = await self._pair(me_id, other["id"])
        if pair is None:
            if not await self.accepts_requests(other["id"]):
                raise TodoError("not_found", 404)
            state = "none"
        elif pair["status"] == "accepted":
            state = "friend"
        else:
            state = "outgoing" if pair["requester"] == me_id else "incoming"
        return {**self._person(other), "state": state}

    async def _fill_usernames(self, me: dict[str, Any]) -> None:
        """아이디를 아직 모르는 예전 계정(같은 서버 사람만)은 봇이 서버 멤버 정보에서 채운다."""
        if self.username_of is None:
            return
        mine = await self.guilds_of(me["user_id"])
        rows = await self.db.fetch_all(
            "SELECT a.id, a.discord_user_id FROM account a"
            " WHERE a.username IS NULL AND a.status = 'active' AND a.id != ?"
            " AND EXISTS (SELECT 1 FROM account_guild g WHERE g.account_id = a.id)"
            " LIMIT ?",
            (me["id"], BACKFILL_MAX),
        )
        for account_id, discord_user_id in rows:
            if int(account_id) in self._tried:
                continue
            self._tried.add(int(account_id))
            other = await self._account(int(account_id))
            if other is None:
                continue
            shared = mine & await self.guilds_of(other["user_id"])
            if not shared:
                continue
            try:
                found = clean_username(await self.username_of(int(discord_user_id), shared))
            except Exception:  # noqa: BLE001 - 봇이 못 찾으면 이번에는 건너뛴다
                log.debug("username backfill failed", exc_info=True)
                continue
            if found:
                async with self.db.writing() as conn:
                    await conn.execute(
                        "UPDATE account SET username = ? WHERE id = ? AND username IS NULL",
                        (found, int(account_id)),
                    )

    # ------------------------------------------------------------ 요청, 수락, 끊기

    async def request(self, me_id: int, raw_other: Any) -> str:
        other_id = _account_id(raw_other)
        me, other = await self._account(me_id), await self._account(other_id)
        if me is None or other is None or other_id == me_id:
            raise TodoError("not_found", 404)
        if not await self._share_guild(me, other) or await self.blocked(me_id, other_id):
            raise TodoError("not_found", 404)  # 같은 서버가 아니거나 차단이면 없는 사람과 같게
        pair = await self._pair(me_id, other_id)
        if pair is not None:
            if pair["status"] == "accepted":
                return "friends"
            if pair["requester"] == other_id:
                return await self.accept(me_id, str(other_id))  # 서로 요청하면 바로 친구
            return "pending"
        if not await self.accepts_requests(other_id):
            raise TodoError("not_found", 404)
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
            # 친구가 아니게 되면 서로의 그룹과 일부 공개 대상에서도 뺀다
            for owner, member in ((me_id, other_id), (other_id, me_id)):
                await conn.execute(
                    "DELETE FROM todo_friend_group_member WHERE member_account = ? AND group_id IN"
                    " (SELECT id FROM todo_friend_group WHERE account_id = ?)",
                    (member, owner),
                )
                await conn.execute(
                    "DELETE FROM todo_category_audience WHERE kind = 'friend' AND target = ?"
                    " AND category_id IN (SELECT id FROM todo_category WHERE account_id = ?)",
                    (member, owner),
                )

    async def block(self, me_id: int, raw_other: Any) -> None:
        """차단: 친구와 요청을 끊고, 서로의 그룹, 일부 공개 대상, 반응에서도 뺀다."""
        other_id = _account_id(raw_other)
        if other_id == me_id or await self._account(other_id) is None:
            raise TodoError("not_found", 404)
        await self.remove(me_id, str(other_id))
        async with self.db.writing() as conn:
            await conn.execute(
                "INSERT OR IGNORE INTO todo_block (account_id, blocked_account, created_at)"
                " VALUES (?, ?, ?)",
                (me_id, other_id, self.now()),
            )
            await conn.execute(
                "DELETE FROM todo_reaction WHERE (owner_account = ? AND reactor_account = ?)"
                " OR (owner_account = ? AND reactor_account = ?)",
                (me_id, other_id, other_id, me_id),
            )

    async def unblock(self, me_id: int, raw_other: Any) -> None:
        other_id = _account_id(raw_other)
        async with self.db.writing() as conn:
            await conn.execute(
                "DELETE FROM todo_block WHERE account_id = ? AND blocked_account = ?",
                (me_id, other_id),
            )

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
        chosen = await self._chosen_categories(owner, viewer) if relation == "friend" else set()
        return relation, [
            row
            for row in rows
            if row["closed_at"] is None
            and can_see(relation, row["visibility"], row["id"] in chosen)
        ]

    async def _chosen_categories(self, owner: int, viewer: int) -> set[int]:
        """일부 공개 카테고리 중 보는 사람이 직접 또는 그룹으로 들어 있는 것."""
        rows = await self.db.fetch_all(
            "SELECT a.category_id FROM todo_category_audience a"
            " JOIN todo_category c ON c.id = a.category_id"
            " WHERE c.account_id = ? AND ((a.kind = 'friend' AND a.target = ?) OR (a.kind = 'group'"
            " AND a.target IN (SELECT m.group_id FROM todo_friend_group_member m"
            " JOIN todo_friend_group g ON g.id = m.group_id"
            " WHERE g.account_id = ? AND m.member_account = ?)))",
            (owner, viewer, owner, viewer),
        )
        return {int(row[0]) for row in rows}

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
        """'나와 친구' 목록: 친구마다 내가 볼 수 있는 TODO의 한 수/전체."""
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

    # ------------------------------------------------------------ 친구 그룹

    async def _friend_ids(self, me_id: int) -> set[int]:
        rows = await self.db.fetch_all(
            "SELECT account_a, account_b FROM todo_friend WHERE status = 'accepted'"
            " AND (account_a = ? OR account_b = ?)",
            (me_id, me_id),
        )
        return {int(b) if int(a) == me_id else int(a) for a, b in rows}

    async def groups(self, me_id: int) -> list[dict[str, Any]]:
        rows = await self.db.fetch_all(
            "SELECT id, name FROM todo_friend_group WHERE account_id = ? ORDER BY name",
            (me_id,),
        )
        friends = await self._friend_ids(me_id)
        result = []
        for group_id, name in rows:
            members = await self.db.fetch_all(
                "SELECT member_account FROM todo_friend_group_member WHERE group_id = ?",
                (group_id,),
            )
            people = []
            for (member,) in members:
                account = await self._account(int(member))
                if account is not None and int(member) in friends:
                    people.append(self._person(account))
            people.sort(key=lambda person: person["name"].casefold())
            result.append({"id": str(group_id), "name": str(name), "members": people})
        return result

    def _group_name(self, raw: Any) -> str:
        if not isinstance(raw, str):
            raise TodoError("bad_name")
        name = " ".join(raw.split())
        if not 1 <= len(name) <= MAX_GROUP_NAME:
            raise TodoError("bad_name")
        return name

    async def _own_group(self, me_id: int, raw_id: Any) -> int:
        group_id = _account_id(raw_id)
        row = await self.db.fetch_one(
            "SELECT id FROM todo_friend_group WHERE id = ? AND account_id = ?", (group_id, me_id)
        )
        if row is None:
            raise TodoError("not_found", 404)
        return group_id

    async def create_group(self, me_id: int, body: dict[str, Any]) -> dict[str, Any]:
        name = self._group_name(body.get("name"))
        count = await self.db.fetch_one(
            "SELECT COUNT(*) FROM todo_friend_group WHERE account_id = ?", (me_id,)
        )
        if count and int(count[0]) >= MAX_GROUPS:
            raise TodoError("too_many_groups", 409)
        try:
            async with self.db.writing() as conn:
                cursor = await conn.execute(
                    "INSERT INTO todo_friend_group (account_id, name, created_at) VALUES (?, ?, ?)",
                    (me_id, name, self.now()),
                )
                group_id = int(cursor.lastrowid or 0)
        except Exception as error:  # 같은 이름
            raise TodoError("duplicate_name", 409) from error
        if "members" in body:
            await self.set_members(me_id, str(group_id), body.get("members"))
        return next(g for g in await self.groups(me_id) if g["id"] == str(group_id))

    async def rename_group(self, me_id: int, raw_id: Any, raw_name: Any) -> None:
        group_id = await self._own_group(me_id, raw_id)
        name = self._group_name(raw_name)
        try:
            async with self.db.writing() as conn:
                await conn.execute(
                    "UPDATE todo_friend_group SET name = ? WHERE id = ?", (name, group_id)
                )
        except Exception as error:
            raise TodoError("duplicate_name", 409) from error

    async def delete_group(self, me_id: int, raw_id: Any) -> None:
        group_id = await self._own_group(me_id, raw_id)
        if self.bin is not None:
            await self.bin.group(me_id, group_id)  # 휴지통에 7일(되살리기)
            return
        async with self.db.writing() as conn:
            await conn.execute(
                "DELETE FROM todo_category_audience WHERE kind = 'group' AND target = ?",
                (group_id,),
            )
            await conn.execute("DELETE FROM todo_friend_group WHERE id = ?", (group_id,))

    async def set_members(self, me_id: int, raw_id: Any, raw_members: Any) -> None:
        group_id = await self._own_group(me_id, raw_id)
        members = self._friend_list(raw_members, await self._friend_ids(me_id))
        async with self.db.writing() as conn:
            await conn.execute(
                "DELETE FROM todo_friend_group_member WHERE group_id = ?", (group_id,)
            )
            for member in members:
                await conn.execute(
                    "INSERT INTO todo_friend_group_member (group_id, member_account) VALUES (?, ?)",
                    (group_id, member),
                )

    @staticmethod
    def _friend_list(raw: Any, friends: set[int]) -> list[int]:
        if not isinstance(raw, list) or len(raw) > MAX_FRIENDS:
            raise TodoError("bad_body")
        result = []
        for item in raw:
            member = _account_id(item)
            if member not in friends:
                raise TodoError("not_friend")
            if member not in result:
                result.append(member)
        return result

    # ------------------------------------------------------------ 카테고리 일부 공개 대상

    async def audience(self, me_id: int, raw_category: Any) -> dict[str, Any]:
        category_id = await self._own_category(me_id, raw_category)
        rows = await self.db.fetch_all(
            "SELECT kind, target FROM todo_category_audience WHERE category_id = ?",
            (category_id,),
        )
        return {
            "friends": [str(t) for k, t in rows if k == "friend"],
            "groups": [str(t) for k, t in rows if k == "group"],
        }

    async def _own_category(self, me_id: int, raw: Any) -> int:
        category_id = _account_id(raw)
        if await self.repo.category(me_id, category_id) is None:
            raise TodoError("not_found", 404)
        return category_id

    async def plan_audience(self, me_id: int, raw_category: Any, body: dict[str, Any]):
        """검사만: (카테고리 ID, 친구 ID들, 그룹 ID들). 그룹에 이미 든 친구는 따로 넣지 않는다."""
        category_id = await self._own_category(me_id, raw_category)
        friends = await self._friend_ids(me_id)
        chosen_friends = self._friend_list(body.get("friends", []), friends)
        raw_groups = body.get("groups", [])
        if not isinstance(raw_groups, list) or len(raw_groups) > MAX_GROUPS:
            raise TodoError("bad_body")
        groups = [await self._own_group(me_id, raw) for raw in dict.fromkeys(raw_groups)]
        in_groups: set[int] = set()
        for group_id in groups:
            rows = await self.db.fetch_all(
                "SELECT member_account FROM todo_friend_group_member WHERE group_id = ?",
                (group_id,),
            )
            in_groups |= {int(row[0]) for row in rows}
        return category_id, [f for f in chosen_friends if f not in in_groups], groups

    async def set_audience(
        self, me_id: int, raw_category: Any, body: dict[str, Any]
    ) -> dict[str, Any]:
        category_id, friends, groups = await self.plan_audience(me_id, raw_category, body)
        async with self.db.writing() as conn:
            await conn.execute(
                "DELETE FROM todo_category_audience WHERE category_id = ?", (category_id,)
            )
            for friend in friends:
                await conn.execute(
                    "INSERT INTO todo_category_audience (category_id, kind, target)"
                    " VALUES (?, 'friend', ?)",
                    (category_id, friend),
                )
            for group_id in groups:
                await conn.execute(
                    "INSERT INTO todo_category_audience (category_id, kind, target)"
                    " VALUES (?, 'group', ?)",
                    (category_id, group_id),
                )
        return await self.audience(me_id, str(category_id))

    async def audience_people(self, me_id: int, category_id: int) -> set[int]:
        """지금 그 카테고리를 볼 수 있는 일부 공개 대상(그룹 풀어서). AI 넓히기 판단용."""
        current = await self.audience(me_id, str(category_id))
        people = {int(f) for f in current["friends"]}
        for group_id in current["groups"]:
            rows = await self.db.fetch_all(
                "SELECT member_account FROM todo_friend_group_member WHERE group_id = ?",
                (int(group_id),),
            )
            people |= {int(row[0]) for row in rows}
        return people

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


def can_see(relation: str, visibility: str, chosen: bool) -> bool:
    """self는 모두, 친구는 전체, 친구, (골랐으면) 일부 공개, 같은 서버 사람은 전체만."""
    if relation == "self":
        return True
    if visibility == "public":
        return True
    if relation != "friend":
        return False
    return visibility == "friends" or (visibility == "selected" and chosen)


def _account_id(raw: Any) -> int:
    if isinstance(raw, int) and not isinstance(raw, bool):
        return raw
    if isinstance(raw, str) and raw.isdigit() and len(raw) <= 18:
        return int(raw)
    raise TodoError("not_found", 404)

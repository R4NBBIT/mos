"""할 일 기능 공개 전 스위치(FLAG). 누가 쓸 수 있는지는 이 파일 한 곳에서만 정한다.

허용되지 않은 계정에게 할 일 기능은 없는 것처럼 보여야 한다(API는 404, 응답에 흔적 없음).
"""

from __future__ import annotations

from mos.config import Settings

FEATURE_NAME = "todo"


class TodoAccess:
    def __init__(self, settings: Settings) -> None:
        self._users = settings.todo_users
        self._operator = settings.operator_discord_id

    def allowed(self, discord_user_id: int) -> bool:
        if self._users is None:  # TODO_USERS=all
            return True
        if self._operator is not None and discord_user_id == self._operator:
            return True
        return discord_user_id in self._users

    @property
    def is_public(self) -> bool:
        """모두에게 열렸는지('나만 보임' 표시를 끈다)."""
        return self._users is None

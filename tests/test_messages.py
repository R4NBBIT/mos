from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace

from mos.services.messages import message_to_row, row_to_api


def fake_message(**overrides: object) -> SimpleNamespace:
    attachment = SimpleNamespace(
        id=555,
        filename="a.png",
        size=1234,
        content_type="image/png",
        url="https://cdn.discordapp.com/attachments/1/2/a.png?ex=1",
        proxy_url="https://media.discordapp.net/attachments/1/2/a.png?ex=1",
        width=10,
        height=20,
        is_spoiler=lambda: True,
    )
    base = {
        "id": 1573319705849102408,
        "guild": SimpleNamespace(id=1573319960745353352),
        "channel": SimpleNamespace(id=1573319705849102409),
        "author": SimpleNamespace(
            id=42,
            name="mocha",
            display_name="모카",
            bot=False,
            display_avatar=SimpleNamespace(url="https://cdn.discordapp.com/avatars/42/x.png"),
        ),
        "webhook_id": None,
        "content": "안녕",
        "embeds": [SimpleNamespace(to_dict=lambda: {"title": "t"})],
        "attachments": [attachment],
        "reference": SimpleNamespace(message_id=7),
        "flags": SimpleNamespace(value=0),
        "created_at": datetime(2026, 11, 20, 1, 2, 3, tzinfo=UTC),
        "edited_at": None,
    }
    base.update(overrides)
    return SimpleNamespace(**base)


def test_row_and_api_shape() -> None:
    row = message_to_row(fake_message())
    assert row["author_name"] == "모카"
    assert row["reference_id"] == 7
    api = row_to_api(row)
    assert api["id"] == "1573319705849102408"  # 큰 ID는 문자열
    assert api["guild_id"] == "1573319960745353352"
    assert api["author"] == {
        "id": "42",
        "name": "모카",
        "avatar_url": "https://cdn.discordapp.com/avatars/42/x.png",
        "bot": False,
        "webhook": False,
    }
    assert api["attachments"][0]["id"] == "555"
    assert api["attachments"][0]["spoiler"] is True
    assert api["embeds"] == [{"title": "t"}]
    assert api["created_at"] == "2026-11-20T01:02:03+00:00"


def test_webhook_message_without_reference() -> None:
    row = message_to_row(fake_message(webhook_id=9, reference=None, attachments=[], embeds=[]))
    api = row_to_api(row)
    assert api["author"]["webhook"] is True
    assert api["reference_id"] is None


def test_mentions_saved_with_names() -> None:
    message = fake_message(
        content="<@42> <@&7> <#9>",
        mentions=[SimpleNamespace(id=42, name="mocha", display_name="모카")],
        role_mentions=[SimpleNamespace(id=7, name="운영")],
        channel_mentions=[SimpleNamespace(id=9, name="일반")],
    )
    api = row_to_api(message_to_row(message))
    assert api["mentions"] == {
        "users": {"42": "모카"},
        "roles": {"7": "운영"},
        "channels": {"9": "일반"},
    }


def test_old_rows_without_mentions() -> None:
    row = message_to_row(fake_message())
    del row["mentions_json"]
    assert row_to_api(row)["mentions"] == {"users": {}, "roles": {}, "channels": {}}

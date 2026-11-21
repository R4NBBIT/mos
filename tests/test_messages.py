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


def test_message_kind_kept() -> None:
    # 입장 알림 같은 시스템 메시지는 종류를 그대로 남긴다(본문이 비어 있다)
    joined = message_to_row(fake_message(type=SimpleNamespace(value=7), content=""))
    assert joined["kind"] == 7
    assert row_to_api(joined)["kind"] == 7
    assert message_to_row(fake_message())["kind"] == 0


def test_stickers_kept() -> None:
    # 스티커만 보낸 메시지도 id·이름·형식을 남겨 웹에서 그림으로 보여 준다
    sticker = SimpleNamespace(id=1234567890123456789, name="빙글", format=SimpleNamespace(value=4))
    row = message_to_row(fake_message(content="", stickers=[sticker]))
    assert row_to_api(row)["stickers"] == [
        {"id": "1234567890123456789", "name": "빙글", "format": 4}
    ]
    old = message_to_row(fake_message())
    del old["stickers_json"]
    assert row_to_api(old)["stickers"] == []


def test_old_web_reply_quote_hidden() -> None:
    # 보낸 기록(web_sent)이 없는 예전 웹 답장도 인용 줄을 떼고 원문 ID로 답장 표시
    content = (
        "> ↪ **ㅁㅁ**: 헐 진짜 된다 [원문](https://discord.com/channels/1/2/1573319705849102499)\n"
        "오옹"
    )
    row = message_to_row(fake_message(content=content, webhook_id=99, reference=None))
    api = row_to_api(row)
    assert api["content"] == "오옹"
    assert api["reference_id"] == "1573319705849102499"
    # 사람이 직접 쓴 같은 모양의 글은 그대로 둔다
    plain = row_to_api(message_to_row(fake_message(content=content, reference=None)))
    assert plain["content"] == content


def test_reaction_counts_merge_bot_and_web_users() -> None:
    from mos.services import reactions

    raw = reactions.adjust("[]", {"id": None, "name": "👍", "animated": False}, 1, by_bot=False)
    raw = reactions.adjust(raw, {"id": None, "name": "👍", "animated": False}, 1, by_bot=True)
    # 디스코드 2개(사람 1 + 봇 1), 웹에서 누른 사람 2명 → 1 + 2 = 3
    users = [("👍", 5, "discord"), ("👍", 42, "web"), ("👍", 43, "web")]
    built = reactions.build(raw, users)
    assert built[0]["count"] == 3 and built[0]["users"] == ["42", "43", "5"]
    # 봇 반응이 빠지고 사람 것도 빠지면 목록에서 사라진다
    raw = reactions.adjust(raw, {"id": None, "name": "👍", "animated": False}, -1, by_bot=True)
    raw = reactions.adjust(raw, {"id": None, "name": "👍", "animated": False}, -1, by_bot=False)
    assert reactions.build(raw, []) == []
    custom = reactions.parse_emoji("<a:dance:1046568093355327518>")
    assert custom == {"id": 1046568093355327518, "name": "dance", "animated": True}
    for bad in ("", "ab", "a b", "x" * 40):
        try:
            reactions.parse_emoji(bad)
        except reactions.ReactionError:
            continue
        raise AssertionError(bad)

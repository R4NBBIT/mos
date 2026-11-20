from __future__ import annotations

import discord

from mos.main import error_hint


def test_hint_for_missing_intents() -> None:
    hint = error_hint(discord.PrivilegedIntentsRequired(None))
    assert hint is not None
    assert "Message Content Intent" in hint


def test_hint_for_bad_token() -> None:
    hint = error_hint(discord.LoginFailure("bad"))
    assert hint is not None
    assert "Reset Token" in hint


def test_no_hint_for_other_errors() -> None:
    assert error_hint(RuntimeError("x")) is None

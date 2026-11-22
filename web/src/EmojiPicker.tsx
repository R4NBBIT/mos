import { useEffect, useMemo, useRef, useState } from "react";
import { type ChannelEmoji, type ChannelSticker, fetchEmojis, fetchStickers } from "./api";
import { viaServer } from "./format";

// 기본(유니코드) 이모지 전체. 처음 열 때만 따로 받아 온다(약 60KB)
interface UnicodeGroup {
  name: string;
  /** [이모지, 검색어(한국어 이름·태그, 영어 단축어), 대표 단축어] */
  emojis: [string, string, string][];
}

let unicodeCache: Promise<UnicodeGroup[]> | null = null;
function loadUnicode(): Promise<UnicodeGroup[]> {
  unicodeCache ??= import("./emoji/unicode.json").then(
    (module) => (module.default as unknown as { groups: UnicodeGroup[] }).groups,
  );
  return unicodeCache;
}

const GROUP_ICONS = ["😀", "🐻", "🍔", "⚽", "🚗", "💡", "🔣", "🏳️"];
const RECENT_KEY = "mos.emoji.recent.v1";
const MAX_RECENT = 32;
const MAX_RESULTS = 240;
const CUSTOM_CODE = /^<(a?):([A-Za-z0-9_]{1,32}):(\d{15,21})>$/;

function emojiImage(id: string, animated: boolean): string {
  // ID는 숫자만 온다(서버가 만든 값)
  return viaServer(`https://cdn.discordapp.com/emojis/${id}.webp?size=48${animated ? "&animated=true" : ""}`);
}

export function emojiCode(emoji: ChannelEmoji): string {
  return `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`;
}

function readRecent(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

function rememberRecent(value: string): void {
  try {
    const next = [value, ...readRecent().filter((item) => item !== value)].slice(0, MAX_RECENT);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // 저장소를 못 쓰면 기억하지 않는다
  }
}

/** 이모지 한 칸: 유니코드는 글자, 모임 이모지 코드는 그림 */
function EmojiButton({ value, title, onPick }: { value: string; title: string; onPick: (value: string) => void }) {
  const custom = CUSTOM_CODE.exec(value);
  return (
    <button type="button" className={custom ? undefined : "emoji-unicode"} title={title} onClick={() => onPick(value)}>
      {custom?.[3] ? (
        <img src={emojiImage(custom[3], custom[1] === "a")} alt={title} loading="lazy" referrerPolicy="no-referrer" />
      ) : (
        value
      )}
    </button>
  );
}

interface Props {
  channelId: string;
  onPick: (text: string) => void;
  onClose: () => void;
  /** 있으면 모임 스티커도 보여 주고, 고르면 바로 보낸다 */
  onPickSticker?: (sticker: ChannelSticker) => void;
}

function stickerImage(sticker: ChannelSticker): string {
  return viaServer(
    `https://media.discordapp.net/stickers/${sticker.id}.${sticker.format === 4 ? "gif" : "png"}?size=160`,
  );
}

export default function EmojiPicker({ channelId, onPick, onClose, onPickSticker }: Props) {
  const [stickers, setStickers] = useState<ChannelSticker[]>([]);
  const wantStickers = Boolean(onPickSticker);
  useEffect(() => {
    if (!wantStickers) return;
    let stopped = false;
    fetchStickers(channelId)
      .then((list) => {
        if (!stopped) setStickers(list.filter((item) => /^\d{15,21}$/.test(item.id)));
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [channelId, wantStickers]);
  const [custom, setCustom] = useState<ChannelEmoji[] | null>(null);
  const [nitro, setNitro] = useState<"none" | "pending" | "verified">("none");
  const [failed, setFailed] = useState(false);
  const [unicode, setUnicode] = useState<UnicodeGroup[] | null>(null);
  const [query, setQuery] = useState("");
  const [recent] = useState(readRecent);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stopped = false;
    fetchEmojis(channelId)
      .then((body) => {
        if (stopped) return;
        setCustom(body.emojis);
        setNitro(body.nitro);
      })
      .catch(() => {
        if (!stopped) setFailed(true);
      });
    loadUnicode()
      .then((groups) => {
        if (!stopped) setUnicode(groups);
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [channelId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pick = (value: string) => {
    rememberRecent(value);
    onPick(value);
  };

  const byGroup = useMemo(() => {
    const map = new Map<string, ChannelEmoji[]>();
    for (const emoji of custom ?? []) {
      const list = map.get(emoji.group_name) ?? [];
      list.push(emoji);
      map.set(emoji.group_name, list);
    }
    return map;
  }, [custom]);

  // 최근 쓴 것: 지금 이 채널에서 쓸 수 있는 모임 이모지와 유니코드만
  const usableCodes = useMemo(() => new Set((custom ?? []).map(emojiCode)), [custom]);
  const recentShown = recent.filter((value) => !CUSTOM_CODE.test(value) || usableCodes.has(value));

  const term = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!term) return null;
    const found: { value: string; title: string }[] = [];
    for (const emoji of custom ?? []) {
      if (emoji.name.toLowerCase().includes(term)) found.push({ value: emojiCode(emoji), title: `:${emoji.name}:` });
    }
    for (const group of unicode ?? []) {
      for (const [char, words, code] of group.emojis) {
        if (found.length >= MAX_RESULTS) break;
        if (words.includes(term)) found.push({ value: char, title: code ? `:${code}:` : char });
      }
    }
    return found;
  }, [term, custom, unicode]);

  const jump = (id: string) => {
    bodyRef.current?.querySelector(`[data-section="${id}"]`)?.scrollIntoView({ block: "start" });
  };

  return (
    <div className="emoji-picker" role="dialog" aria-label="이모지 고르기">
      <div className="emoji-top">
        <input
          className="emoji-search"
          type="search"
          value={query}
          placeholder="이모지 찾기(예: 웃음, 하트, smile)"
          aria-label="이모지 찾기"
          onChange={(event) => setQuery(event.target.value)}
        />
        {!term && (
          <div className="emoji-tabs" role="tablist" aria-label="이모지 분류">
            {byGroup.size > 0 && (
              <button type="button" title="서버 이모지" onClick={() => jump("server")}>
                ⭐
              </button>
            )}
            {recentShown.length > 0 && (
              <button type="button" title="최근 쓴 이모지" onClick={() => jump("recent")}>
                🕘
              </button>
            )}
            {stickers.length > 0 && (
              <button type="button" title="스티커" onClick={() => jump("stickers")}>
                🏷️
              </button>
            )}
            {(unicode ?? []).map((group, index) => (
              <button key={group.name} type="button" title={group.name} onClick={() => jump(`u${index}`)}>
                {GROUP_ICONS[index] ?? "•"}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="emoji-body" ref={bodyRef}>
        {results ? (
          results.length > 0 ? (
            <div className="emoji-grid">
              {results.map((item) => (
                <EmojiButton key={item.value} value={item.value} title={item.title} onPick={pick} />
              ))}
            </div>
          ) : (
            <p className="emoji-note">{unicode ? "찾는 이모지가 없어요." : "이모지를 불러오는 중이에요…"}</p>
          )
        ) : (
          <>
            {recentShown.length > 0 && (
              <section data-section="recent">
                <h3>최근 쓴 이모지</h3>
                <div className="emoji-grid">
                  {recentShown.map((value) => (
                    <EmojiButton key={value} value={value} title={value} onPick={pick} />
                  ))}
                </div>
              </section>
            )}
            {stickers.length > 0 && onPickSticker && (
              <section data-section="stickers">
                <h3>스티커</h3>
                <p className="emoji-note sticker-note">
                  누르면 바로 보내져요. 디스코드에서는 스티커가 아니라 <strong>사진</strong>으로 보여요(디스코드가
                  다른 앱에서 진짜 스티커를 보내지 못하게 막아 두었어요). 움직이는 스티커는 움직이는 사진으로 가요.
                </p>
                <div className="sticker-grid">
                  {stickers.map((sticker) => (
                    <button
                      key={sticker.id}
                      type="button"
                      title={`${sticker.name} (${sticker.group_name})`}
                      onClick={() => onPickSticker(sticker)}
                    >
                      <img src={stickerImage(sticker)} alt={sticker.name} loading="lazy" referrerPolicy="no-referrer" />
                    </button>
                  ))}
                </div>
              </section>
            )}
            {[...byGroup.entries()].map(([groupName, emojis], index) => (
              <section key={groupName} data-section={index === 0 ? "server" : undefined}>
                <h3>{groupName}</h3>
                <div className="emoji-grid">
                  {emojis.map((emoji) => (
                    <EmojiButton key={emoji.id} value={emojiCode(emoji)} title={`:${emoji.name}:`} onPick={pick} />
                  ))}
                </div>
              </section>
            ))}
            {custom !== null && nitro === "none" && (
              <p className="emoji-note">
                움직이는 이모지와 다른 서버 이모지는 니트로가 있어야 쓸 수 있어요. 니트로가 있으면 계정 메뉴에서 '니트로
                있어요'를 켜 주세요.
              </p>
            )}
            {custom !== null && nitro === "pending" && (
              <p className="emoji-note">
                니트로 확인이 필요해요. 디스코드 앱에서 움직이는 이모지나 다른 서버 이모지를 한 번 보내거나 반응으로 달아
                주세요(확인되면 7일 동안 유지돼요).
              </p>
            )}
            {failed && <p className="emoji-note">서버 이모지를 불러오지 못했어요.</p>}
            {unicode === null && <p className="emoji-note">기본 이모지를 불러오는 중이에요…</p>}
            {(unicode ?? []).map((group, index) => (
              <section key={group.name} data-section={`u${index}`}>
                <h3>{group.name}</h3>
                <div className="emoji-grid">
                  {group.emojis.map(([char, , code]) => (
                    <EmojiButton key={char} value={char} title={code ? `:${code}:` : char} onPick={pick} />
                  ))}
                </div>
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

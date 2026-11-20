import { useEffect, useState } from "react";
import { type ChannelEmoji, fetchEmojis } from "./api";

// 자주 쓰는 유니코드 이모지(누구나 쓸 수 있다)
const UNICODE_GROUPS: { name: string; emojis: string[] }[] = [
  {
    name: "표정",
    emojis: "😀 😁 😂 🤣 😊 😍 🥰 😘 😎 🤔 😐 😑 😶 🙄 😏 😮 😪 😴 😌 😛 😜 🤪 😝 🤤 😒 😓 😔 😕 🙃 🫠 🤑 😲 🥲 😭 😢 😤 😠 😡 🤯 😳 🥺 😱 😨 😰 😥 🤗 🫡 🤫 🤭 😇 🥳 🤓 😈 💀 👻 🤖 💩".split(" "),
  },
  {
    name: "손·몸",
    emojis: "👍 👎 👏 🙌 🙏 🤝 👌 ✌️ 🤞 🤟 👋 💪 👀 🫶 ✋ 👊 🤙 👆 👇 👈 👉".split(" "),
  },
  {
    name: "마음",
    emojis: "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 💕 💖 💯 ✨ 🔥 ⭐ 🎉 🎊 💤 💢 💦".split(" "),
  },
  {
    name: "음식",
    emojis: "🍚 🍜 🍝 🍕 🍔 🍟 🌭 🍗 🥩 🍣 🍱 🥟 🍙 🍰 🍩 🍪 🍫 🍦 ☕ 🧋 🍺 🍻 🥤 🍎 🍓".split(" "),
  },
  {
    name: "동물·물건",
    emojis: "🐶 🐱 🐰 🐻 🐼 🐹 🐥 🐸 🐢 🐟 🌸 🌈 ☀️ 🌙 ⛄ 🎮 💻 📱 📌 💡 🎵 🎁 ✅ ❌ ❓ ❗".split(" "),
  },
];

function emojiImage(emoji: ChannelEmoji): string {
  // ID는 숫자만 온다(서버가 만든 값)
  return `https://cdn.discordapp.com/emojis/${emoji.id}.${emoji.animated ? "gif" : "webp"}?size=48`;
}

export function emojiCode(emoji: ChannelEmoji): string {
  return `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`;
}

interface Props {
  channelId: string;
  onPick: (text: string) => void;
  onClose: () => void;
}

export default function EmojiPicker({ channelId, onPick, onClose }: Props) {
  const [custom, setCustom] = useState<ChannelEmoji[] | null>(null);
  const [nitro, setNitro] = useState<"none" | "pending" | "verified">("none");
  const [failed, setFailed] = useState(false);

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

  const byGroup = new Map<string, ChannelEmoji[]>();
  for (const emoji of custom ?? []) {
    const list = byGroup.get(emoji.group_name) ?? [];
    list.push(emoji);
    byGroup.set(emoji.group_name, list);
  }

  return (
    <div className="emoji-picker" role="dialog" aria-label="이모지 고르기">
      {[...byGroup.entries()].map(([groupName, emojis]) => (
        <section key={groupName}>
          <h3>{groupName}</h3>
          <div className="emoji-grid">
            {emojis.map((emoji) => (
              <button
                key={emoji.id}
                type="button"
                title={`:${emoji.name}:`}
                onClick={() => onPick(emojiCode(emoji))}
              >
                <img src={emojiImage(emoji)} alt={`:${emoji.name}:`} loading="lazy" referrerPolicy="no-referrer" />
              </button>
            ))}
          </div>
        </section>
      ))}
      {custom !== null && nitro === "none" && (
        <p className="emoji-note">
          움직이는 이모지와 다른 모임 이모지는 니트로가 있어야 쓸 수 있어요. 니트로가 있으면 프로필 메뉴에서
          '니트로 있어요'를 켜 주세요.
        </p>
      )}
      {custom !== null && nitro === "pending" && (
        <p className="emoji-note">
          니트로 확인이 필요해요. 디스코드 앱에서 움직이는 이모지나 다른 서버 이모지를 한 번 보내거나 반응으로 달아
          주세요(확인되면 7일 동안 유지돼요).
        </p>
      )}
      {failed && <p className="emoji-note">모임 이모지를 불러오지 못했어요.</p>}
      {UNICODE_GROUPS.map((group) => (
        <section key={group.name}>
          <h3>{group.name}</h3>
          <div className="emoji-grid">
            {group.emojis.map((emoji) => (
              <button key={emoji} type="button" className="emoji-unicode" onClick={() => onPick(emoji)}>
                {emoji}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

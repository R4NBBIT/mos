// 입력칸의 @사람, #채널 자동완성. 화면에는 '@이름'으로 보이고, 보낼 때 디스코드 멘션(<@ID>, <#ID>)으로 바꾼다
import { fetchGroupChannels, fetchGroupMembers } from "./api";

export interface MentionItem {
  kind: "@" | "#";
  id: string;
  name: string;
  avatar?: string | null;
  bot?: boolean;
}

const MAX_ITEMS = 8;
const TRIGGER = /(^|\s)([@#])([^\s@#]{0,32})$/;

/** 커서 앞이 '@글자'나 '#글자'면 (종류, 시작 위치, 찾는 글자) */
export function findTrigger(text: string, caret: number): { kind: "@" | "#"; start: number; query: string } | null {
  const match = TRIGGER.exec(text.slice(0, caret));
  if (!match) return null;
  const kind = match[2] as "@" | "#";
  const query = match[3] ?? "";
  return { kind, start: caret - query.length - 1, query };
}

const cache = new Map<string, { at: number; people: MentionItem[]; channels: MentionItem[]; restricted: Record<string, string[]> }>();
const CACHE_MS = 60_000;

/** 그 서버의 사람과 채널(1분 기억). 실패하면 빈 목록 */
export async function loadMentionData(groupId: string) {
  const cached = cache.get(groupId);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached;
  const [members, channels] = await Promise.all([
    fetchGroupMembers(groupId).catch(() => null),
    fetchGroupChannels(groupId).catch(() => null),
  ]);
  const value = {
    at: Date.now(),
    people: (members?.members ?? []).map((member) => ({
      kind: "@" as const,
      id: member.id,
      name: member.name,
      avatar: member.avatar_url,
      bot: member.bot,
    })),
    channels: (channels?.channels ?? [])
      .filter((channel) => channel.kind !== "thread")
      .map((channel) => ({ kind: "#" as const, id: channel.id, name: channel.name })),
    restricted: members?.restricted ?? {},
  };
  cache.set(groupId, value);
  return value;
}

/** 찾는 글자로 거르기: 이름이 그 글자로 시작하는 것 먼저 */
export function filterItems(items: MentionItem[], query: string): MentionItem[] {
  const needle = query.toLocaleLowerCase();
  const scored = items
    .map((item) => {
      const name = item.name.toLocaleLowerCase();
      const at = name.indexOf(needle);
      return { item, at };
    })
    .filter(({ at }) => at >= 0)
    .sort((a, b) => (a.at === 0 ? 0 : 1) - (b.at === 0 ? 0 : 1) || a.item.name.localeCompare(b.item.name, "ko"));
  return scored.slice(0, MAX_ITEMS).map(({ item }) => item);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** '@이름', '#채널'로 고른 것을 보낼 때 <@ID>, <#ID>로 바꾼다(긴 이름 먼저) */
export function applyMentions(text: string, picked: Record<string, string>): string {
  let result = text;
  for (const token of Object.keys(picked).sort((a, b) => b.length - a.length)) {
    const id = picked[token];
    if (!id || !/^\d{1,21}$/.test(id)) continue;
    const code = token.startsWith("#") ? `<#${id}>` : `<@${id}>`;
    result = result.replace(new RegExp(`${escapeRegExp(token)}(?=$|[\\s.,!?;:)\\]}'"])`, "gu"), code);
  }
  return result;
}

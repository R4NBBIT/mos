// 이모지 선택창의 기본(유니코드) 이모지 목록을 만든다.
// 원본: emojibase-data(MIT, https://emojibase.dev) — 한국어 이름·태그(ko)와 영어 단축어(github, iamcal).
// 쓰는 법: npm pack emojibase-data 로 받은 package 폴더를 주고 실행한다.
//   node scripts/build-emoji-data.mjs <emojibase-data 폴더> > src/emoji/unicode.json
// 윈도우·맥 기본 글꼴에 없는 최신 이모지는 네모로 보여, MAX_VERSION 이하만 넣는다.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_VERSION = 15.0;
const root = process.argv[2];
if (!root) {
  console.error("emojibase-data 폴더를 주세요");
  process.exit(1);
}
const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const data = read("ko/data.json");
const messages = read("ko/messages.json");
const shortcodes = [read("en/shortcodes/github.json"), read("en/shortcodes/iamcal.json")];

// 디스코드처럼 묶는다: 사람(표정+사람), 자연, 음식, 활동, 여행, 사물, 기호, 깃발
const groupOf = { 0: 0, 1: 0, 3: 1, 4: 2, 6: 3, 5: 4, 7: 5, 8: 6, 9: 7 };
const names = ["사람", "자연", "음식", "활동", "여행", "사물", "기호", "깃발"];
const groups = names.map((name) => ({ name, emojis: [] }));
void messages;

const sorted = data.filter((item) => item.group in groupOf && (item.version ?? 99) <= MAX_VERSION);
sorted.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
for (const item of sorted) {
  const codes = new Set();
  for (const table of shortcodes) {
    const value = table[item.hexcode];
    for (const code of Array.isArray(value) ? value : value ? [value] : []) codes.add(code);
  }
  const words = [item.label, ...(item.tags ?? []), ...codes].join(" ").toLowerCase();
  const first = [...codes][0] ?? "";
  groups[groupOf[item.group]].emojis.push([item.emoji, words, first]);
}
process.stdout.write(JSON.stringify({ source: "emojibase-data 18.0.0 (MIT)", groups }));

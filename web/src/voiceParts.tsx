// 음성 채널 목록 줄, 들어가 있는 사람 줄, 상태 아이콘. 왼쪽 목록과 음성 채널 화면이 같이 쓴다
import type { ReactNode } from "react";
import type { ListSkin } from "./listSkin";
import { lockIcon } from "./listSkin";
import { Avatar } from "./MessageItem";
import type { ChannelInfo, VoiceChannel, VoiceMember } from "./types";

function Icon({ label, children }: { label: string; children: ReactNode }) {
  return (
    <svg className="voice-icon" width="14" height="14" viewBox="0 0 20 20" role="img" aria-label={label}>
      <title>{label}</title>
      {children}
    </svg>
  );
}

const micOff = (
  <Icon label="마이크 꺼짐">
    <rect x="7.5" y="3" width="5" height="9" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path d="M5 10a5 5 0 0 0 10 0M10 15v2.5M3 3l14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </Icon>
);

const soundOff = (
  <Icon label="소리 꺼짐">
    <path
      d="M4 12v-2a6 6 0 0 1 12 0v2M4 12h2.5v4H4zM13.5 12H16v4h-2.5zM3 3l14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Icon>
);

const screenOn = (
  <Icon label="화면 공유 중">
    <rect x="2.5" y="4" width="15" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path d="M7 17h6M10 14v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </Icon>
);

const cameraOn = (
  <Icon label="카메라 켬">
    <rect x="2.5" y="5.5" width="10.5" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path d="M13 9l4.5-2.5v7L13 11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
  </Icon>
);

/** '마이크 꺼짐', '마이크, 소리 꺼짐', '화면 공유 중' 처럼 */
export function voiceStatus(member: VoiceMember): string {
  const parts: string[] = [];
  if (member.muted && member.deafened) parts.push("마이크, 소리 꺼짐");
  else if (member.muted) parts.push("마이크 꺼짐");
  else if (member.deafened) parts.push("소리 꺼짐");
  if (member.streaming) parts.push("화면 공유 중");
  if (member.video) parts.push("카메라 켬");
  return parts.join(", ");
}

/** 상태 아이콘 묶음. 칸 너비가 정해져 있어서 줄마다 오른쪽 끝이 맞는다 */
export function VoiceIcons({ member }: { member: VoiceMember }) {
  return (
    <span className="voice-icons">
      {member.video && cameraOn}
      {member.streaming && screenOn}
      {member.muted && micOff}
      {member.deafened && soundOff}
    </span>
  );
}

/** 왼쪽 목록: 음성 채널 한 줄과 그 아래 들어가 있는 사람 */
export function VoiceRow({
  voice,
  skin,
  active,
  indent = 0,
  onOpen,
}: {
  voice: VoiceChannel;
  skin: ListSkin;
  active?: boolean;
  indent?: number;
  onOpen: (voice: VoiceChannel) => void;
}) {
  const classes = ["list-item", "voice-item"];
  if (active) classes.push("list-item-active");
  if (indent) classes.push("list-item-indent");
  const count = voice.members.length;
  return (
    <>
      <div
        className={classes.join(" ")}
        role="button"
        tabIndex={0}
        aria-label={count ? `${voice.name}, ${count}명 들어가 있음` : voice.name}
        onClick={() => onOpen(voice)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onOpen(voice);
        }}
      >
        <span className="channel-mark">{skin.voiceIcon(voice)}</span>
        <span className="list-name">
          {voice.name}
          {skin.voiceExt && <span className="skin-ext">{skin.voiceExt}</span>}
        </span>
        {voice.private && (
          <span className="list-people" title="비공개" aria-label="비공개">
            {lockIcon}
          </span>
        )}
        {count > 0 && <span className="voice-count">{skin.voiceCount(count)}</span>}
      </div>
      {count > 0 && (
        <ul className={indent ? "voice-people voice-people-indent" : "voice-people"}>
          {voice.members.map((member) => (
            <li key={member.id} className="voice-person" title={voiceStatus(member) || member.name}>
              <Avatar url={member.avatar_url} name={member.name} />
              <span className="voice-person-name">{member.name}</span>
              <VoiceIcons member={member} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export interface SectionWithVoice {
  key: string;
  name: string | null;
  channels: ChannelInfo[];
  voice: VoiceChannel[];
}

/**
 * 카테고리 묶음에 음성 채널을 끼운다. 디스코드처럼 묶음 안에서는 글 채널 다음에 음성 채널,
 * 음성 채널만 있는 카테고리는 카테고리 순서 자리에 새 묶음으로
 */
export function withVoice(
  sections: { key: string; name: string | null; channels: ChannelInfo[] }[],
  voice: VoiceChannel[] | null,
): SectionWithVoice[] {
  const result: (SectionWithVoice & { position: number; index: number })[] = sections.map((section, index) => ({
    ...section,
    voice: [],
    position: section.channels[0]?.category_position ?? (section.key ? index : -1),
    index,
  }));
  for (const item of voice ?? []) {
    const key = item.category_id ?? "";
    let section = result.find((entry) => entry.key === key);
    if (!section) {
      section = {
        key,
        name: item.category_name,
        channels: [],
        voice: [],
        position: item.category_position,
        index: result.length,
      };
      result.push(section);
    }
    section.voice.push(item);
  }
  return result
    .sort((a, b) => a.position - b.position || a.index - b.index)
    .map(({ key, name, channels, voice: rooms }) => ({ key, name, channels, voice: rooms }));
}

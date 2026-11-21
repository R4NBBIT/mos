// 디스코드 시스템 메시지(입장·고정·부스트 등). 본문이 비어 있어 따로 문장을 만들어 보여 준다.
// 종류 번호는 디스코드 메시지 type 값.
import type { Message } from "./types";

/** 보통 말풍선으로 보이는 종류: 보통·답장·명령 응답 */
const NORMAL_KINDS = new Set([0, 19, 20, 23]);
/** 화면에 아예 안 보이는 종류: 스레드 첫 메시지 표시(본문 카드가 따로 있다) */
const HIDDEN_KINDS = new Set([21]);

export function isSystemMessage(message: Message): boolean {
  return !NORMAL_KINDS.has(message.kind ?? 0);
}

export function isHiddenMessage(message: Message): boolean {
  return HIDDEN_KINDS.has(message.kind ?? 0);
}

/** 시스템 메시지 문장. 이름·채널 이름은 그대로 글자로 넣는다(React가 이스케이프) */
export function systemText(message: Message): string {
  const name = message.author.name;
  const extra = message.content.trim();
  switch (message.kind) {
    case 1:
      return `${name}님이 참여했어요`;
    case 2:
      return `${name}님이 나갔어요`;
    case 4:
      return extra ? `${name}님이 채널 이름을 '${extra}'(으)로 바꿨어요` : `${name}님이 채널 이름을 바꿨어요`;
    case 6:
      return `${name}님이 메시지를 고정했어요`;
    case 7:
      return `${name}님이 들어왔어요`;
    case 8:
      return /^\d+$/.test(extra) && extra !== "1"
        ? `${name}님이 서버를 ${extra}번 부스트했어요`
        : `${name}님이 서버를 부스트했어요`;
    case 9:
    case 10:
    case 11:
      return `${name}님이 서버를 부스트해 서버가 ${message.kind - 8}레벨이 됐어요`;
    case 12:
      return `${name}님이 다른 채널 소식을 받아 오도록 추가했어요`;
    case 18:
      return extra ? `${name}님이 스레드를 시작했어요: ${extra}` : `${name}님이 스레드를 시작했어요`;
    case 24:
      return "자동 관리 기능이 메시지를 막았어요";
    case 46:
      return "투표가 끝났어요";
    default:
      return "디스코드 알림";
  }
}

/** 보통 메시지인데 보여 줄 게 하나도 없을 때(스티커·투표 등 아직 못 그리는 것) */
export function isEmptyMessage(message: Message): boolean {
  return !message.content.trim() && message.attachments.length === 0 && message.embeds.length === 0;
}

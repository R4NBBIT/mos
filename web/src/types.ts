// 서버 API 응답 모양. 디스코드 ID는 모두 문자열이다(자바스크립트 숫자 정밀도 문제).

export interface Author {
  id: string;
  name: string;
  avatar_url: string | null;
  bot: boolean;
  webhook: boolean;
}

export interface Attachment {
  id: string;
  filename: string;
  size: number;
  content_type: string | null;
  url: string;
  proxy_url: string;
  width: number | null;
  height: number | null;
  spoiler: boolean;
}

export interface Embed {
  title?: string;
  description?: string;
  url?: string;
}

export interface Message {
  id: string;
  channel_id: string;
  guild_id: string | null;
  author: Author;
  content: string;
  embeds: Embed[];
  attachments: Attachment[];
  reference_id: string | null;
  created_at: string;
  edited_at: string | null;
}

export interface MessagePage {
  messages: Message[];
  has_more: boolean;
}

export interface ChannelInfo {
  id: string;
  name: string;
  guild_id: string;
  guild_name: string;
}

export type RealtimeEvent =
  | { type: "message_create" | "message_update"; data: Message }
  | { type: "message_delete"; data: { channel_id: string; ids: string[] } };

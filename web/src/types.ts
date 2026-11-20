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

/** 본문 멘션 코드의 ID → 받을 때 시점의 이름 */
export interface Mentions {
  users: Record<string, string>;
  roles: Record<string, string>;
  channels: Record<string, string>;
}

export interface Message {
  id: string;
  channel_id: string;
  guild_id: string | null;
  author: Author;
  content: string;
  /** ㅁㅇㅅ 웹에서 보낸 메시지면 보낸 사람의 디스코드 ID */
  web_sender_id: string | null;
  embeds: Embed[];
  attachments: Attachment[];
  mentions: Mentions;
  reference_id: string | null;
  created_at: string;
  edited_at: string | null;
}

export interface MessagePage {
  messages: Message[];
  has_more: boolean;
}

/** 모임 = 디스코드 서버(화면에는 '서버'라고 쓰지 않는다) */
export interface Group {
  id: string;
  name: string;
  icon_url: string | null;
  pinned?: boolean;
  unread?: number;
  /** 나를 부른(멘션) 안 읽은 메시지 수 */
  mentions?: number;
}

export type ChannelKind = "text" | "news" | "forum" | "thread";

export interface ChannelInfo {
  id: string;
  name: string;
  kind: ChannelKind;
  group_id: string;
  /** 채널 하나를 따로 물을 때만 온다 */
  group_name?: string;
  category_id: string | null;
  category_name: string | null;
  can_send: boolean;
  pinned?: boolean;
  unread?: number;
  mentions?: number;
  /** 포럼: 새 글 쓰기 권한, 태그가 꼭 필요한지, 고를 수 있는 태그 */
  can_post?: boolean;
  require_tag?: boolean;
  tags?: ForumTag[];
  /** 스레드(포럼 글): 부모 채널, 잠김·보관 여부 */
  parent_id?: string | null;
  locked?: boolean;
  archived?: boolean;
  /** 채널 하나를 따로 물을 때만(스레드): 부모 이름·종류, 붙은 태그, 첫 메시지 */
  parent_name?: string;
  parent_kind?: ChannelKind;
  applied_tags?: ForumTag[];
  starter?: Message | null;
}

export interface ForumTag {
  id: string;
  name: string;
  emoji: string | null;
  /** 관리자 전용 태그는 false(고를 수 없음) */
  usable: boolean;
}

/** 포럼 글 또는 채널의 스레드 하나 */
export interface ThreadSummary {
  id: string;
  name: string;
  tag_ids: string[];
  archived: boolean;
  locked: boolean;
  message_count: number;
  created_at: string;
  last_message_at: string;
  /** 포럼 글의 첫 메시지 미리보기(받아 둔 경우만) */
  preview: string | null;
}

export interface ThreadPage {
  parent: ChannelInfo;
  threads: ThreadSummary[];
  has_more: boolean;
  next_before: number | null;
}

export interface GroupList {
  groups: Group[];
  /** 고정한 채널(모임 목록 맨 위 바로가기) */
  pinned_channels: ChannelInfo[];
}

export interface GroupChannels {
  group: Group;
  channels: ChannelInfo[];
}

export type RealtimeEvent =
  | { type: "message_create" | "message_update"; data: Message }
  | { type: "message_delete"; data: { channel_id: string; ids: string[] } }
  | { type: "subscribed" | "subscribe_denied"; data: { channel_id: string } };

/** 이 브라우저에 저장된 계정 하나 */
export interface SessionAccount {
  id: string;
  /** 디스코드 사용자 ID. 내 메시지를 알아보는 데 쓴다 */
  user_id: string;
  name: string;
  avatar_url: string | null;
  password_set: boolean;
  /** 디스코드 연결 직후 5분 동안만 true(비밀번호 정하기·재설정) */
  can_set_password: boolean;
  locked: boolean;
  /** '로그인 유지' 중 */
  kept: boolean;
  /** 니트로: none(안 켬) · pending(켰지만 확인 전·만료) · verified(7일 안에 확인됨) */
  nitro: "none" | "pending" | "verified";
  /** 확인이 유지되는 때(유닉스 초) */
  nitro_until: number | null;
  disconnected: boolean;
}

export interface SessionState {
  accounts: SessionAccount[];
  active_account_id: string | null;
  max_accounts: number;
}

// 음성 채널에 누가 들어가 있는지. 서버마다 한 번 받아 두고 여러 화면(왼쪽 목록, 음성 채널 화면)이 같이 쓴다.
// 이 탭에서 연결 하나로 '바뀜' 신호만 받고, 신호가 오면 그 서버 것을 다시 받는다(누가 어디인지는 API가 권한을 보고 준다)
import { useEffect, useState } from "react";
import { fetchGroupVoice } from "./api";
import type { VoiceChannel } from "./types";

const REFETCH_DELAY_MS = 400; // 들고 나는 일이 몰려도 한 번만 다시 받는다
const FALLBACK_MS = 60_000; // 연결이 안 되어도 1분마다는 새로 받는다
const MAX_RETRY_MS = 30_000;
const PING_MS = 30_000;
const POLICY_VIOLATION = 1008;
const MAX_GROUPS = 10;

type Listener = (channels: VoiceChannel[] | null) => void;

interface Entry {
  listeners: Set<Listener>;
  data: VoiceChannel[] | null;
  timer?: number;
}

const entries = new Map<string, Entry>();
let socket: WebSocket | null = null;
let retryMs = 1000;
let retryTimer: number | undefined;
let pingTimer: number | undefined;
let fallbackTimer: number | undefined;
let rejected = false;

function load(groupId: string) {
  const entry = entries.get(groupId);
  if (!entry) return;
  fetchGroupVoice(groupId)
    .then(({ channels }) => {
      const current = entries.get(groupId);
      if (!current) return;
      current.data = channels;
      current.listeners.forEach((listener) => listener(channels));
    })
    .catch(() => {
      // 못 받으면 보이던 것을 그대로 둔다(잠김, 권한 없음이면 목록 쪽이 알아서 처리)
    });
}

function later(groupId: string) {
  const entry = entries.get(groupId);
  if (!entry) return;
  window.clearTimeout(entry.timer);
  entry.timer = window.setTimeout(() => load(groupId), REFETCH_DELAY_MS);
}

function sendGroups() {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "voice", group_ids: [...entries.keys()].slice(0, MAX_GROUPS) }));
  }
}

function connect() {
  if (socket || rejected || entries.size === 0) return;
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  const current = new WebSocket(`${scheme}://${window.location.host}/ws`);
  socket = current;
  current.onopen = () => {
    retryMs = 1000;
    sendGroups();
    entries.forEach((_, groupId) => load(groupId)); // 끊긴 사이 바뀐 것
    pingTimer = window.setInterval(() => current.send("ping"), PING_MS);
  };
  current.onmessage = (message) => {
    if (typeof message.data !== "string" || message.data === "pong") return;
    try {
      const event = JSON.parse(message.data) as { type?: string; data?: { group_id?: unknown } };
      if (event.type === "voice_changed" && typeof event.data?.group_id === "string") later(event.data.group_id);
    } catch {
      // 알 수 없는 형식은 무시
    }
  };
  current.onclose = (event) => {
    window.clearInterval(pingTimer);
    if (socket === current) socket = null;
    if (event.code === POLICY_VIOLATION) {
      rejected = true; // 잠김, 계정 바뀜: 화면이 새로 열릴 때 다시
      return;
    }
    if (entries.size === 0) return;
    retryTimer = window.setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
  };
}

function stopAll() {
  window.clearTimeout(retryTimer);
  window.clearInterval(pingTimer);
  window.clearInterval(fallbackTimer);
  fallbackTimer = undefined;
  socket?.close();
  socket = null;
}

function onVisible() {
  if (document.visibilityState === "visible") entries.forEach((_, groupId) => load(groupId));
}

function subscribe(groupId: string, listener: Listener): () => void {
  let entry = entries.get(groupId);
  const first = entries.size === 0;
  if (!entry) {
    entry = { listeners: new Set(), data: null };
    entries.set(groupId, entry);
    load(groupId);
    sendGroups();
  } else if (entry.data) {
    listener(entry.data);
  }
  entry.listeners.add(listener);
  if (first) {
    rejected = false;
    connect();
    document.addEventListener("visibilitychange", onVisible);
    fallbackTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") entries.forEach((_, id) => load(id));
    }, FALLBACK_MS);
  }
  return () => {
    const current = entries.get(groupId);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size > 0) return;
    window.clearTimeout(current.timer);
    entries.delete(groupId);
    sendGroups();
    if (entries.size === 0) {
      document.removeEventListener("visibilitychange", onVisible);
      stopAll();
    }
  };
}

/** 그 서버의 음성 채널(볼 수 있는 것만). 꺼져 있거나 아직이면 null */
export function useVoiceChannels(groupId: string | null, enabled: boolean): VoiceChannel[] | null {
  const [channels, setChannels] = useState<VoiceChannel[] | null>(null);
  useEffect(() => {
    setChannels(null);
    if (!groupId || !enabled) return;
    return subscribe(groupId, setChannels);
  }, [groupId, enabled]);
  return channels;
}

/** 휴대폰, 태블릿처럼 손가락으로만 쓰는 기기 */
export function isTouchOnly(): boolean {
  return window.matchMedia("(pointer: coarse)").matches && !window.matchMedia("(any-pointer: fine)").matches;
}

const SNOWFLAKE = /^\d{1,21}$/;

function channelPath(groupId: string, channelId: string): string {
  if (!SNOWFLAKE.test(groupId) || !SNOWFLAKE.test(channelId)) throw new Error("bad id");
  return `channels/${groupId}/${channelId}`;
}

export function discordWebUrl(groupId: string, channelId: string): string {
  return `https://discord.com/${channelPath(groupId, channelId)}`;
}

/** 설치된 디스코드 앱(컴퓨터)으로 그 채널 열기 */
export function discordAppUrl(groupId: string, channelId: string): string {
  return `discord://-/${channelPath(groupId, channelId)}`;
}

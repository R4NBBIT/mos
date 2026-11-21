// 처음 사용 안내(계정마다 한 번, 계정 메뉴 '사용 방법'으로 다시 보기).
// 실제로 볼 수 있는 모임·채널을 살펴서, 모임이 없을 때·빈 모임·포럼만 있는 모임·읽기만 되는 모임처럼
// 그 사람 상황에 맞는 카드를 고른다.
import { type ReactNode, useEffect, useState } from "react";
import { fetchGroupChannels, fetchGroups } from "./api";
import { bossKeyLabel, parseBossKey } from "./boss/bossKey";
import { isTouchOnly } from "./device";
import type { Settings } from "./theme";
import type { ChannelInfo } from "./types";
import { askPopupPermission, popupSupport, type PopupSupport } from "./useNotifications";

const MAX_SCANNED_GROUPS = 12; // 모임이 아주 많으면 앞의 몇 개만 살핀다
const MAX_NAMES = 3;

interface GroupSummary {
  name: string;
  chat: number; // 쓸 수 있는 채팅 채널
  readOnly: number; // 읽기만 되는 채팅 채널
  forum: number;
  forumPostable: number;
}

interface Situation {
  groupCount: number;
  scanned: GroupSummary[];
  failed: boolean;
}

function summarize(name: string, channels: ChannelInfo[]): GroupSummary {
  const chats = channels.filter((channel) => channel.kind === "text" || channel.kind === "news");
  const forums = channels.filter((channel) => channel.kind === "forum");
  return {
    name,
    chat: chats.filter((channel) => channel.can_send).length,
    readOnly: chats.filter((channel) => !channel.can_send).length,
    forum: forums.length,
    forumPostable: forums.filter((channel) => channel.can_post).length,
  };
}

async function lookAround(): Promise<Situation> {
  const list = await fetchGroups();
  const groups = list.groups.slice(0, MAX_SCANNED_GROUPS);
  const scanned = await Promise.all(
    groups.map(async (group) => {
      try {
        const body = await fetchGroupChannels(group.id);
        return summarize(group.name, body.channels);
      } catch {
        return null;
      }
    }),
  );
  return {
    groupCount: list.groups.length,
    scanned: scanned.filter((item): item is GroupSummary => item !== null),
    failed: false,
  };
}

function names(groups: GroupSummary[]): string {
  const shown = groups.slice(0, MAX_NAMES).map((group) => `'${group.name}'`);
  const rest = groups.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} 외 ${rest}곳` : shown.join(", ");
}

interface Card {
  id: string;
  title: string;
  body: ReactNode;
}

function buildCards(
  situation: Situation | null,
  settings: Settings,
  wide: boolean,
  popup: PopupSupport,
  onAskPopup: () => void,
): Card[] {
  const touchOnly = isTouchOnly();
  const cards: Card[] = [
    {
      id: "hello",
      title: "반가워요!",
      body: (
        <>
          <p>디스코드 서버 채팅을 평범한 업무 화면처럼 보이게 읽고 쓰는 곳이에요.</p>
          <ul>
            <li>여기서 보낸 글은 디스코드에 그 서버의 내 별명·프로필로 올라가고, 이름 옆에 '앱' 표시가 붙어요.</li>
            <li>화면과 탭 제목 어디에도 디스코드라는 말이 나오지 않아요.</li>
          </ul>
        </>
      ),
    },
  ];

  // 모임 상황
  if (situation === null) {
    cards.push({
      id: "groups",
      title: "모임 살펴보는 중…",
      body: <p>볼 수 있는 모임과 채널을 확인하고 있어요.</p>,
    });
  } else if (situation.failed) {
    cards.push({
      id: "groups",
      title: "모임 → 채널 → 대화",
      body: (
        <p>
          디스코드 서버는 여기서 '모임'이라고 불러요. 모임을 고르고, 채널을 고르면 대화가 열려요. (지금은 모임 목록을
          불러오지 못해서 자세한 안내는 건너뛸게요.)
        </p>
      ),
    });
  } else if (situation.groupCount === 0) {
    cards.push({
      id: "groups",
      title: "아직 볼 수 있는 모임이 없어요",
      body: (
        <>
          <p>ㅁㅇㅅ 봇이 들어가 있는 디스코드 서버에 나도 들어가 있어야 모임이 보여요.</p>
          <ul>
            <li>서버 관리자에게 ㅁㅇㅅ 봇 초대를 부탁해 주세요.</li>
            <li>봇이 들어오거나 내가 그 서버에 들어가면, 잠시 뒤 목록에 저절로 나타나요.</li>
          </ul>
        </>
      ),
    });
  } else {
    const empty = situation.scanned.filter((g) => g.chat + g.readOnly + g.forum === 0);
    const forumOnly = situation.scanned.filter((g) => g.chat + g.readOnly === 0 && g.forum > 0);
    const readOnlyOnly = situation.scanned.filter((g) => g.chat === 0 && g.readOnly > 0 && g.forumPostable === 0);
    const where = wide
      ? "넓은 화면에서는 왼쪽 목록에서 고르고, 목록 옆 얇은 띠(‹)를 누르면 목록을 접을 수 있어요."
      : "목록에서 하나씩 눌러 들어가고, 맨 위 ‹ 버튼으로 돌아와요.";
    cards.push({
      id: "groups",
      title: `볼 수 있는 모임 ${situation.groupCount}곳`,
      body: (
        <>
          <p>디스코드 서버를 여기서는 '모임'이라고 불러요. 모임 → 채널 → 대화 순서로 들어가요. {where}</p>
          <ul>
            <li>☆를 눌러 자주 가는 모임·채널을 맨 위에 고정할 수 있어요.</li>
            <li>안 읽은 글 수가 숫자로, 나를 부른 글은 빨간 '@ 숫자'로 보여요.</li>
            {settings.theme === "sheet" && <li>스프레드시트 테마에서는 같은 모임의 채널이 아래 시트 탭으로 나와요.</li>}
            {empty.length > 0 && (
              <li>
                {names(empty)}에는 볼 수 있는 채널이 없어요. 채널이 아직 없거나, ㅁㅇㅅ 봇이 그 채널을 볼 수 없어서예요.
                비공개 채널은 서버 관리자가 채널마다 봇을 추가해야 보여요.
              </li>
            )}
            {forumOnly.length > 0 && (
              <li>{names(forumOnly)}은(는) 채팅 채널 없이 포럼만 있어요. 뒤에 나오는 '포럼과 스레드' 카드를 봐 주세요.</li>
            )}
            {readOnlyOnly.length > 0 && (
              <li>
                {names(readOnlyOnly)}은(는) 읽기만 할 수 있어요('읽기만' 표시). 디스코드에서 내게 쓰기 권한이 없는
                채널이라 여기서도 쓸 수 없어요.
              </li>
            )}
            {situation.groupCount > situation.scanned.length && (
              <li>모임이 많아 앞의 {situation.scanned.length}곳만 살펴봤어요.</li>
            )}
          </ul>
        </>
      ),
    });

    const anyChat = situation.scanned.some((g) => g.chat > 0);
    const anyForum = situation.scanned.some((g) => g.forum > 0);
    const anyPostable = situation.scanned.some((g) => g.forumPostable > 0);
    if (anyChat) {
      cards.push({
        id: "chat",
        title: "대화하기",
        body: (
          <ul>
            <li>
              {touchOnly ? "말풍선을 누르면" : "메시지를 누르면"} 답장·고치기·지우기 버튼이 나와요. 고치기·지우기는 여기서 내가
              보낸 글만 돼요.
            </li>
            <li>＋로 사진·파일(한 번에 10개, 합쳐서 10MB)을, 웃는 얼굴로 이모지를 넣어요.</li>
            <li>움직이는 이모지·다른 모임 이모지는 니트로가 필요해요. 니트로가 있으면 계정 메뉴에서 '니트로 있어요'를 켜 주세요.</li>
            <li>/로 시작하는 다른 봇 명령은 글자로만 올라가고 실행되지 않아요.</li>
          </ul>
        ),
      });
    }
    if (anyForum) {
      cards.push({
        id: "forum",
        title: "포럼과 스레드",
        body: (
          <ul>
            <li>포럼(▤)을 누르면 글 목록이 나와요. 글을 열면 본문 아래에 댓글로 이야기해요.</li>
            {anyPostable ? (
              <li>'새 글'로 제목·내용·태그를 적어 글을 올릴 수 있어요(포럼에 글쓰기 권한이 있을 때).</li>
            ) : (
              <li>지금은 새 글을 올릴 권한이 있는 포럼이 없어요. 글 읽기와 댓글은 권한에 따라 돼요.</li>
            )}
            <li>지난 글은 목록 아래 '지난 글 더 보기'로 볼 수 있어요.</li>
            {anyChat && <li>일반 채널의 스레드는 채팅방 위 '스레드' 버튼으로 열어요.</li>}
          </ul>
        ),
      });
    }
  }

  cards.push({
    id: "boss",
    title: "누가 오면, 위장 화면",
    body: touchOnly ? (
      <ul>
        <li>화면 왼쪽 아래 모서리를 누르면 업무 표로 바뀌고, 한 번 더 누르면 보던 화면으로 돌아와요.</li>
        <li>휴대폰·태블릿에는 키보드가 없어 보스키는 쓸 수 없어요(컴퓨터에서는 {bossKeyLabel(parseBossKey(settings.boss_key))}).</li>
        <li>보여 줄 표는 설정 › 위장 화면에서 바꿀 수 있어요.</li>
      </ul>
    ) : (
      <ul>
        <li>
          어느 화면에서든 보스키(<strong>{bossKeyLabel(parseBossKey(settings.boss_key))}</strong>)를 누르면 업무 표로 바뀌고,
          한 번 더 누르면 보던 화면 그대로 돌아와요.
        </li>
        <li>화면 왼쪽 아래 모서리를 눌러도 돼요.</li>
        <li>보스키, 보여 줄 표, 자동 위장은 설정 › 위장 화면에서 바꿔요.</li>
      </ul>
    ),
  });

  cards.push({
    id: "notify",
    title: "알림",
    body: (
      <>
        <ul>
          <li>나를 부른 글(@내 이름, 내 글에 답장)과 고정한 채널의 새 글이 오면 탭 제목 앞에 숫자가 붙어요.</li>
          <li>다른 창을 보고 있으면 알림 창도 떠요. 내용은 보이지 않고 '새 알림 n건'만 나와요.</li>
          <li>이 탭이 열려 있을 때만 알려요. 끄거나 바꾸려면 설정 › 알림.</li>
        </ul>
        {popup === "default" && (
          <button type="button" className="pill-button pill-button-strong" onClick={onAskPopup}>
            이 브라우저에서 알림 허용하기
          </button>
        )}
        {popup === "granted" && <p className="guide-ok">알림 창을 띄울 수 있어요.</p>}
        {popup === "denied" && (
          <p className="guide-note">알림 창이 막혀 있어요. 주소창 왼쪽 자물쇠(사이트 설정)에서 알림을 허용해 주세요.</p>
        )}
        {popup === "unsupported" && (
          <p className="guide-note">이 브라우저(휴대폰 등)에서는 알림 창을 띄울 수 없어 탭 제목 숫자로만 알려요.</p>
        )}
      </>
    ),
  });

  cards.push({
    id: "last",
    title: "마지막으로",
    body: (
      <ul>
        <li>설정에서 테마(기본·다크·스프레드시트·메모장)와 탭 제목을 바꿀 수 있어요.</li>
        <li>30분 동안 아무것도 안 하면 저절로 잠겨요. 잠금 해제는 처음 정한 비밀번호로 해요.</li>
        <li>한 브라우저에 계정을 5개까지 넣고 계정 메뉴에서 바꿀 수 있어요.</li>
        <li>이 안내는 계정 메뉴 › '사용 방법'에서 다시 볼 수 있어요.</li>
      </ul>
    ),
  });
  return cards;
}

interface Props {
  settings: Settings;
  wide: boolean;
  onClose: () => void;
}

export default function Guide({ settings, wide, onClose }: Props) {
  const [situation, setSituation] = useState<Situation | null>(null);
  const [step, setStep] = useState(0);
  const [popup, setPopup] = useState<PopupSupport>(popupSupport);

  useEffect(() => {
    let stopped = false;
    lookAround()
      .then((value) => {
        if (!stopped) setSituation(value);
      })
      .catch(() => {
        if (!stopped) setSituation({ groupCount: 0, scanned: [], failed: true });
      });
    return () => {
      stopped = true;
    };
  }, []);

  const cards = buildCards(situation, settings, wide, popup, () => void askPopupPermission().then(setPopup));
  const index = Math.min(step, cards.length - 1);
  const card = cards[index];
  const last = index === cards.length - 1;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!card) return null;
  return (
    <div className="guide-layer" role="dialog" aria-modal="true" aria-labelledby="guide-title">
      <div className="guide-card">
        <div className="guide-top">
          <span className="guide-step">
            {index + 1} / {cards.length}
          </span>
          <button type="button" className="guide-skip" onClick={onClose}>
            건너뛰기
          </button>
        </div>
        <h2 id="guide-title" className="guide-title">
          {card.title}
        </h2>
        <div className="guide-body">{card.body}</div>
        <div className="guide-dots" aria-hidden="true">
          {cards.map((item, dot) => (
            <span key={item.id} className={dot === index ? "on" : ""} />
          ))}
        </div>
        <div className="guide-actions">
          {index > 0 && (
            <button type="button" className="pill-button" onClick={() => setStep(index - 1)}>
              이전
            </button>
          )}
          <button
            type="button"
            className="pill-button pill-button-strong"
            onClick={() => (last ? onClose() : setStep(index + 1))}
          >
            {last ? "시작하기" : "다음"}
          </button>
        </div>
      </div>
    </div>
  );
}

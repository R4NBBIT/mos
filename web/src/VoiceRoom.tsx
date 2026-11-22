// 음성 채널 화면: 지금 들어가 있는 사람과 '디스코드에서 참여'. 여기서는 듣거나 말할 수 없다.
// 참여 단추: 컴퓨터는 설치된 디스코드 앱을 먼저 열고 2초 뒤 웹으로 여는 링크를 보여 주고,
// 휴대폰과 태블릿은 웹 주소를 그대로 연다(앱이 있으면 기기가 앱으로 연다)
import { type ReactNode, useEffect, useState } from "react";
import BackIcon from "./BackIcon";
import { Avatar } from "./MessageItem";
import SplitToggle from "./SplitToggle";
import { isTouchOnly } from "./device";
import { discordAppUrl, discordWebUrl, useVoiceChannels } from "./voice";
import { VoiceIcons, voiceStatus } from "./voiceParts";

const WEB_LINK_DELAY_MS = 2000;

function JoinButton({ groupId, channelId }: { groupId: string; channelId: string }) {
  const [touch] = useState(isTouchOnly);
  const [attempt, setAttempt] = useState(0);
  const [showWeb, setShowWeb] = useState(false);
  const webUrl = discordWebUrl(groupId, channelId);

  // 앱이 있는지 브라우저로는 알 수 없어서, 눌러 보고 2초 뒤 웹 링크를 보여 준다
  useEffect(() => {
    if (attempt === 0) return;
    const timer = window.setTimeout(() => setShowWeb(true), WEB_LINK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [attempt]);

  if (touch) {
    return (
      <a className="voice-join" href={webUrl} target="_blank" rel="noopener noreferrer">
        디스코드에서 참여
      </a>
    );
  }
  return (
    <>
      <button
        type="button"
        className="voice-join"
        onClick={() => {
          setShowWeb(false);
          window.location.href = discordAppUrl(groupId, channelId);
          setAttempt((value) => value + 1);
        }}
      >
        디스코드에서 참여
      </button>
      {showWeb && (
        <a className="voice-web-link" href={webUrl} target="_blank" rel="noopener noreferrer">
          앱이 안 열리면 웹에서 열기
        </a>
      )}
    </>
  );
}

export default function VoiceRoom({
  groupId,
  channelId,
  showBack,
  onBack,
  menu,
  notice,
  onNoticeClose,
}: {
  groupId: string;
  channelId: string;
  showBack: boolean;
  onBack: () => void;
  menu: ReactNode;
  notice?: string;
  onNoticeClose?: () => void;
}) {
  // 설정에서 목록에 안 보이게 했어도, 주소로 직접 온 화면은 보여 준다
  const channels = useVoiceChannels(groupId, true);
  const voice = channels?.find((item) => item.id === channelId);
  const people = voice?.members ?? [];

  return (
    <div className="room voice-room">
      <header className="room-header">
        <SplitToggle />
        {showBack && (
          <button type="button" className="back-button" onClick={onBack} aria-label="채널 목록으로">
            <BackIcon />
          </button>
        )}
        <div className="room-title">
          <strong>{voice ? voice.name : "…"}</strong>
          <span className="room-sub">{voice?.group_name ?? ""}</span>
        </div>
        {menu}
      </header>
      {notice && (
        <div className="room-notice" role="status">
          <span>{notice}</span>
          <button type="button" className="text-button" onClick={onNoticeClose} aria-label="안내 닫기">
            닫기
          </button>
        </div>
      )}
      <div className="voice-body">
        {channels && !voice ? (
          <p className="list-note">이 채널을 볼 수 없어요. 목록에서 다시 골라 주세요.</p>
        ) : (
          <>
            <section className="voice-card" aria-live="polite">
              <h2 className="voice-card-title">
                {!channels
                  ? "불러오는 중…"
                  : people.length
                    ? `지금 들어가 있는 사람 ${people.length}명`
                    : "지금은 아무도 없어요"}
              </h2>
              {people.length > 0 && (
                <ul className="voice-list">
                  {people.map((member) => (
                    <li key={member.id} className="voice-list-row">
                      <Avatar url={member.avatar_url} name={member.name} />
                      <span className="voice-list-name">
                        <span className="voice-list-text">{member.name}</span>
                        {member.bot && <span className="member-bot">봇</span>}
                      </span>
                      <span className="voice-list-status">{voiceStatus(member)}</span>
                      <VoiceIcons member={member} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {voice && (
              <div className="voice-join-box">
                <JoinButton groupId={groupId} channelId={channelId} />
                <p className="voice-join-note">
                  디스코드 앱이나 웹에서 이 채널이 열려요. 여기서는 듣거나 말할 수 없어요.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

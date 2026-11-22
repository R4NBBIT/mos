// 설정이 어디에 적용되는지: 모든 기기(계정에 저장) 또는 이 기기(이 브라우저, 설치한 앱)
export default function Scope({ device = false }: { device?: boolean }) {
  return (
    <span className={device ? "scope-chip scope-chip-device" : "scope-chip"}>{device ? "이 기기" : "모든 기기"}</span>
  );
}

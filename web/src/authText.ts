// 서버가 주는 구분 문자열 → 화면 문장. 화면에는 '디스코드'를 쓰지 않는다(위장).

const messages: Record<string, string> = {
  // 계정 연결(주소의 connect_error)
  cancelled: "연결을 취소했어요.",
  expired: "연결 시간이 지났어요. 처음부터 다시 해 주세요.",
  connect_failed: "연결하지 못했어요. 잠시 후 다시 해 주세요.",
  no_server: "함께 쓰는 서버에 들어가 있는 계정만 쓸 수 있어요.",
  too_many_accounts: "이 브라우저에는 계정을 5개까지 둘 수 있어요. 하나를 뺀 뒤 다시 해 주세요.",
  bad_request: "잘못된 요청이에요. 처음부터 다시 해 주세요.",
  // 비밀번호
  password_too_short: "비밀번호는 8자 이상이어야 해요.",
  password_too_long: "비밀번호는 128자까지예요.",
  password_too_common: "너무 쉬운 비밀번호예요. 다른 걸로 정해 주세요.",
  setup_expired: "비밀번호를 정할 수 있는 시간(5분)이 지났어요. 계정을 다시 연결해 주세요.",
  wrong_password: "비밀번호가 맞지 않아요.",
  too_many_attempts: "여러 번 틀려서 잠시 막혔어요.",
  password_not_set: "아직 비밀번호가 없는 계정이에요. 계정을 다시 연결해 주세요.",
  account_disconnected: "연결이 끊긴 계정이에요. 다시 연결해 주세요.",
  rate_limited: "요청이 너무 많아요. 1분 뒤에 다시 해 주세요.",
  forbidden: "이 주소로는 들어올 수 없어요. 정해진 주소로 다시 열어 주세요.",
};

export function authText(code: string, retryAfter?: number | null): string {
  const base = messages[code] ?? "문제가 생겼어요. 잠시 후 다시 해 주세요.";
  if (code === "too_many_attempts" && retryAfter) {
    return `${base} ${Math.ceil(retryAfter / 60)}분 뒤에 다시 해 주세요.`;
  }
  return base;
}

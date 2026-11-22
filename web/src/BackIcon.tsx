// 뒤로 단추의 꺾쇠. 글자(‹)는 글꼴마다 아래로 처져서 옆 제목과 줄이 안 맞아 그림으로 그린다.
// 크기는 단추 글자 크기(em)를 따른다(테마마다 단추 글자 크기가 다르다).
export default function BackIcon() {
  return (
    <svg className="back-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M10 3L5 8l5 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

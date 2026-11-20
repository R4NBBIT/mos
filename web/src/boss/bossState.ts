// 위장 화면이 떠 있는지. 떠 있는 동안에는 채팅을 '읽음'으로 남기지 않는다(보지 않았으니까)
let disguised = false;

export function setDisguised(value: boolean): void {
  disguised = value;
}

export function isDisguised(): boolean {
  return disguised;
}

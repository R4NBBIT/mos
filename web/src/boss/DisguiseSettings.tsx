// 설정 › 위장 화면: 보여 줄 화면 고르기(테마와 같은 이름으로 예시 4가지, 내 파일 4가지, 그 밖에 사진과 다른 사이트),
// 파일 올리기와 지우기, 모두 처음으로 되돌리기. 파일과 고친 내용은 계정에 저장된다.
import { fetchCategories, type TodoCategory } from "../todo/todoApi";
import { type ChangeEvent, type ReactNode, useEffect, useState } from "react";
import type { BossTemplate, Settings } from "../theme";
import {
  type AssetKind,
  type AssetList,
  cachedInfo,
  fetchBossInfo,
  removeAsset,
  resetAll,
  resetEdits,
  uploadAsset,
} from "./bossStore";
import { clearMyFile, FileImportError, importMyFile, readDocx } from "./myFile";
import { EDIT_KEYS } from "./OtherDisguise";
import { useTodoAllowed } from "../todo/feature";

/** 내 파일 종류: 올리는 곳, 고른 화면, 지웠을 때 돌아갈 예시 */
const FILE_SLOTS: {
  kind: AssetKind;
  template: BossTemplate;
  example: BossTemplate;
  app: string;
  accept: string;
  hint: string;
}[] = [
  {
    kind: "sheet",
    template: "myfile",
    example: "weekly",
    app: "스프레드시트",
    accept: ".xlsx,.xlsm,.csv",
    hint: ".xlsx, .csv",
  },
  {
    kind: "text",
    template: "text",
    example: "memo",
    app: "메모장",
    accept: ".txt,text/plain",
    hint: ".txt",
  },
  {
    kind: "note",
    template: "notefile",
    example: "note",
    app: "노션",
    accept: ".md,.markdown,.txt,text/plain,text/markdown",
    hint: ".md, .txt",
  },
  {
    kind: "word",
    template: "wordfile",
    example: "word",
    app: "Word",
    accept: ".docx",
    hint: ".docx",
  },
];

const EXAMPLES: { template: BossTemplate; label: string }[] = [
  { template: "weekly", label: "스프레드시트: 주간 업무 보고" },
  { template: "memo", label: "메모장: 업무 메모" },
  { template: "note", label: "노션: 업무 정리 페이지" },
  { template: "word", label: "Word: 주간 업무 보고 문서" },
];

/** 예전 표 예시(매출 요약 등)는 스프레드시트 예시로 보여 준다 */
function shownTemplate(template: BossTemplate): BossTemplate {
  return template === "sales" || template === "schedule" || template === "budget" ? "weekly" : template;
}

const MAX_IMAGE = 4 * 1024 * 1024;
const MAX_TEXT = 200 * 1024;

const uploadErrors: Record<string, string> = {
  file_too_large: "파일이 너무 커요.",
  bad_image: "사진 파일(PNG, JPG, WebP, GIF)만 올릴 수 있어요.",
  bad_text: "글자(UTF-8) 파일만 올릴 수 있어요.",
};

function errorText(caught: unknown): string {
  if (caught instanceof FileImportError) return caught.message;
  const code = (caught as { code?: string } | null)?.code ?? "";
  return uploadErrors[code] ?? "올리지 못했어요. 잠시 후 다시 해 주세요.";
}

/** 4MB가 넘는 스크린샷은 같은 크기로 WebP로 다시 저장하고, 그래도 크면 조금씩 줄인다 */
async function shrinkImage(file: File): Promise<Blob> {
  if (file.size <= MAX_IMAGE) return file;
  const bitmap = await createImageBitmap(file);
  let scale = 1;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
    if (blob && blob.size <= MAX_IMAGE) return blob;
    scale *= 0.8;
  }
  throw new FileImportError("사진이 너무 커요. 더 작은 사진을 골라 주세요.");
}

async function readText(file: File): Promise<string> {
  if (file.size > MAX_TEXT) throw new FileImportError("200KB보다 작은 글 파일만 불러올 수 있어요.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("euc-kr").decode(bytes); // 한글 윈도우 메모장의 옛 저장 방식
  }
}

interface Props {
  settings: Settings;
  save: (changes: Partial<Settings>) => Promise<void>;
  onFileChanged: () => void;
}

export default function DisguiseSettings({ settings, save, onFileChanged }: Props) {
  const [info, setInfo] = useState<AssetList>(cachedInfo);
  const [busy, setBusy] = useState<AssetKind | null>(null);
  const [error, setError] = useState("");
  const [url, setUrl] = useState(settings.boss_url ?? "");
  const [askRemove, setAskRemove] = useState<AssetKind | null>(null);
  const [resetState, setResetState] = useState<"idle" | "confirm" | "busy" | "done">("idle");
  const todoOk = useTodoAllowed();
  const current = settings.boss_template === "todo" && !todoOk ? "weekly" : shownTemplate(settings.boss_template);

  useEffect(() => {
    fetchBossInfo()
      .then(setInfo)
      .catch(() => {});
  }, []);
  useEffect(() => setUrl(settings.boss_url ?? ""), [settings.boss_url]);

  const upload = async (kind: AssetKind, event: ChangeEvent<HTMLInputElement>, then: BossTemplate) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(kind);
    setError("");
    try {
      if (kind === "sheet") {
        const stored = await importMyFile(file); // 브라우저에서 읽어 표만 만든다(원본은 보내지 않음)
        await uploadAsset("sheet", stored.fileName, JSON.stringify(stored));
      } else if (kind === "image") {
        await uploadAsset("image", file.name, await shrinkImage(file));
      } else if (kind === "word") {
        await uploadAsset("word", file.name, await readDocx(file)); // 글만 뽑아 저장(원본은 보내지 않음)
        await resetEdits(EDIT_KEYS.wordfile).catch(() => {});
      } else {
        await uploadAsset(kind, file.name, await readText(file));
        await resetEdits(kind === "note" ? EDIT_KEYS.notefile : EDIT_KEYS.text).catch(() => {}); // 새 글을 불러오면 그 글부터
      }
      setInfo(await fetchBossInfo().catch(() => cachedInfo()));
      onFileChanged();
      if (settings.boss_template !== then) await save({ boss_template: then });
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (kind: AssetKind, template: BossTemplate, example: BossTemplate) => {
    setError("");
    try {
      await removeAsset(kind);
      if (kind === "sheet") clearMyFile();
      setInfo(await fetchBossInfo().catch(() => cachedInfo()));
      onFileChanged();
      if (settings.boss_template === template) await save({ boss_template: example });
    } catch (caught) {
      setError(errorText(caught));
    }
  };

  // 모두 처음으로: 올린 파일과 고친 내용(표, 메모장, 노션, Word)을 전부 지운다. 확인 창에서 '모두 지우기'를 눌러야 하고 취소할 수 있다
  const resetEverything = async () => {
    setResetState("busy");
    setError("");
    try {
      await resetAll();
      clearMyFile();
      setInfo({});
      onFileChanged();
      const slot = FILE_SLOTS.find((item) => item.template === settings.boss_template);
      if (slot) await save({ boss_template: slot.example });
      else if (settings.boss_template === "image") await save({ boss_template: "weekly" });
      setResetState("done");
    } catch {
      setError("되돌리지 못했어요. 잠시 후 다시 해 주세요.");
      setResetState("idle");
    }
  };

  // 파일 지우기도 되살릴 수 없으니 '지울까요? 지우기 / 취소'로 한 번 묻는다
  const removeButton = (kind: AssetKind, template: BossTemplate, example: BossTemplate) =>
    askRemove === kind ? (
      <span className="inline-confirm" role="alertdialog" aria-label="파일 지우기 확인">
        <span>지울까요?</span>
        <button
          type="button"
          className="pill-button pill-button-danger"
          onClick={() => {
            setAskRemove(null);
            void remove(kind, template, example);
          }}
        >
          지우기
        </button>
        <button type="button" className="pill-button" onClick={() => setAskRemove(null)}>
          취소
        </button>
      </span>
    ) : (
      <button type="button" className="pill-button" onClick={() => setAskRemove(kind)}>
        지우기
      </button>
    );

  const choice = (id: BossTemplate, label: ReactNode, disabled = false, extra?: ReactNode) => (
    <div key={id} className="boss-choice-block">
      <label className={disabled ? "boss-choice boss-choice-off" : "boss-choice"}>
        <input
          type="radio"
          name="boss-template"
          checked={current === id}
          disabled={disabled}
          onChange={() => void save({ boss_template: id })}
        />
        {label}
      </label>
      {extra && <div className="boss-choice-extra">{extra}</div>}
    </div>
  );

  const fileButton = (kind: AssetKind, text: string, accept: string, then: BossTemplate) => (
    <label className={busy === kind ? "pill-button busy" : "pill-button"}>
      {busy === kind ? "올리는 중…" : text}
      <input
        type="file"
        accept={accept}
        hidden
        disabled={busy !== null}
        onChange={(event) => void upload(kind, event, then)}
      />
    </label>
  );

  return (
    <>
      <div className="settings-item">
        <h3 className="settings-sub">보여 줄 화면</h3>
        <div className="boss-group" role="radiogroup" aria-label="위장 화면">
          <p className="boss-group-title">예시</p>
          {EXAMPLES.map((item) => choice(item.template, item.label))}
          {todoOk &&
            choice(
              "todo",
              "내 TODO: 오늘 TODO(지금 테마 모양, 체크하면 저장됨)",
              false,
              current === "todo" ? (
                <BossTodoCategories
                  chosen={settings.boss_todo_categories}
                  onChange={(ids) => void save({ boss_todo_categories: ids })}
                />
              ) : undefined,
            )}

          <p className="boss-group-title">내 파일</p>
          {FILE_SLOTS.map((slot) => {
            const found = info[slot.kind];
            return choice(
              slot.template,
              <>
                {slot.app}: {found ? found.name : <span className="boss-empty">아직 없음</span>}
              </>,
              !found && current !== slot.template,
              <div className="settings-buttons">
                {fileButton(
                  slot.kind,
                  found ? "다른 파일 불러오기" : `불러오기(${slot.hint})`,
                  slot.accept,
                  slot.template,
                )}
                {found && removeButton(slot.kind, slot.template, slot.example)}
              </div>,
            );
          })}
          <p className="boss-hint">
            예시와 불러온 파일 모두 위장 화면에서 바로 고칠 수 있어요. 엑셀과 Word 파일은 이 브라우저에서 읽어 글과 표만
            저장해요.
          </p>

          <p className="boss-group-title">그 밖에</p>
          {choice(
            "image",
            <>내 화면 사진: {info.image ? info.image.name : <span className="boss-empty">아직 없음</span>}</>,
            !info.image && current !== "image",
            <>
              <div className="settings-buttons">
                {fileButton(
                  "image",
                  info.image ? "다른 사진 올리기" : "사진 올리기",
                  "image/png,image/jpeg,image/webp,image/gif",
                  "image",
                )}
                {info.image && removeButton("image", "image", "weekly")}
              </div>
              {current === "image" && (
                <div className="boss-fit" role="radiogroup" aria-label="사진 맞추기">
                  <label>
                    <input
                      type="radio"
                      name="boss-fit"
                      checked={settings.boss_fit === "cover"}
                      onChange={() => void save({ boss_fit: "cover" })}
                    />
                    화면에 꽉 채우기(가장자리가 조금 잘릴 수 있음)
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="boss-fit"
                      checked={settings.boss_fit === "contain"}
                      onChange={() => void save({ boss_fit: "contain" })}
                    />
                    사진 전체 보이기(남는 곳은 사진 가장자리 색으로)
                  </label>
                </div>
              )}
              <p className="boss-hint">평소 쓰는 업무 화면을 전체 화면으로 캡처해 올리면 가장 자연스러워요.</p>
            </>,
          )}
          {choice(
            "url",
            "다른 사이트로 이동",
            false,
            current === "url" ? (
              <>
                <form
                  className="settings-row"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save({ boss_url: url.trim() || null });
                  }}
                >
                  <input
                    aria-label="이동할 주소"
                    value={url}
                    maxLength={300}
                    placeholder="https://로 시작하는 주소"
                    onChange={(event) => setUrl(event.target.value)}
                    onBlur={() => {
                      if ((url.trim() || null) !== settings.boss_url) void save({ boss_url: url.trim() || null });
                    }}
                  />
                </form>
                <p className="boss-hint">
                  보스키를 누르면 이 주소로 바로 넘어가요. 돌아오려면 브라우저 뒤로 가기를 누르고, 보던 화면은 다시
                  불러와요(쓰던 글은 사라질 수 있어요). 자동 위장은 이 방식에서 동작하지 않아요.
                </p>
              </>
            ) : null,
          )}
        </div>
        {error && <p className="list-error">{error}</p>}
      </div>

      <div className="settings-item">
        <h3 className="settings-sub">모두 처음으로</h3>
        {resetState === "confirm" || resetState === "busy" ? (
          <div className="confirm-box" role="alertdialog" aria-label="모두 지우기 확인">
            <p>올린 파일과 고친 내용을 모두 지울까요? 지운 뒤에는 되살릴 수 없어요.</p>
            <div className="settings-buttons">
              <button
                type="button"
                className="pill-button pill-button-danger"
                disabled={resetState === "busy"}
                onClick={() => void resetEverything()}
              >
                {resetState === "busy" ? "지우는 중…" : "모두 지우기"}
              </button>
              <button
                type="button"
                className="pill-button"
                disabled={resetState === "busy"}
                onClick={() => setResetState("idle")}
              >
                취소
              </button>
            </div>
          </div>
        ) : (
          <div className="settings-buttons">
            <button type="button" className="pill-button" onClick={() => setResetState("confirm")}>
              올린 파일과 고친 내용 모두 지우기
            </button>
            {resetState === "done" && (
              <span className="settings-done" role="status">
                처음 상태로 되돌렸어요.
              </span>
            )}
          </div>
        )}
        <p className="settings-item-note">
          올린 파일(표, 사진, 메모장, 노션, Word)을 모두 지우고, 예시에 고친 내용도 처음으로 돌아가요. 파일과 고친
          내용은 계정에 암호화해 저장돼서 다른 브라우저나 PC에서도 그대로 보이고, 여기서 지우면 모든 곳에서 지워져요.
        </p>
      </div>
    </>
  );
}

/** 위장 화면 'TODO'에 보일 카테고리 고르기(이 기기, 아무것도 고르지 않으면 모두) */
function BossTodoCategories({ chosen, onChange }: { chosen: string[]; onChange: (ids: string[]) => void }) {
  const [categories, setCategories] = useState<TodoCategory[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    fetchCategories()
      .then((value) => setCategories(value.categories.filter((category) => !category.closed)))
      .catch(() => setFailed(true));
  }, []);
  if (failed) return <p className="boss-hint">카테고리를 불러오지 못했어요.</p>;
  if (!categories) return null;
  const known = chosen.filter((id) => categories.some((category) => category.id === id));
  return (
    <div className="boss-todo-pick" role="group" aria-label="위장 화면에 보일 카테고리">
      <p className="boss-hint">보일 카테고리(이 기기에만 적용돼요. 아무것도 고르지 않으면 모두 보여요)</p>
      {categories.map((category) => (
        <label key={category.id} className="boss-choice">
          <input
            type="checkbox"
            checked={known.includes(category.id)}
            onChange={(event) =>
              onChange(event.target.checked ? [...known, category.id] : known.filter((id) => id !== category.id))
            }
          />
          {category.name}
        </label>
      ))}
    </div>
  );
}

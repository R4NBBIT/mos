// 설정 › 위장 화면: 보여 줄 화면 고르기(표 템플릿, 내 표 파일, 내 화면 사진, 글 문서, 다른 사이트),
// 파일 올리기·지우기, 고친 내용 되돌리기. 파일과 고친 내용은 계정에 저장된다.
import { type ChangeEvent, type ReactNode, useEffect, useState } from "react";
import type { BossTemplate, Settings } from "../theme";
import { type AssetKind, type AssetList, cachedInfo, fetchBossInfo, removeAsset, resetEdits, uploadAsset } from "./bossStore";
import { clearMyFile, FileImportError, importMyFile } from "./myFile";
import { TEXT_EDIT_KEY } from "./OtherDisguise";
import { TEMPLATE_NAMES } from "./templates";

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

/** 고친 내용을 기억하는 열쇠(App의 pickWorkbook과 같게) */
function editKey(template: BossTemplate, info: AssetList): string | null {
  if (template === "myfile") return info.sheet ? `mos.boss.edits.v1.myfile.${info.sheet.version}` : null;
  if (template === "text") return TEXT_EDIT_KEY;
  if (template === "image" || template === "url") return null;
  return `mos.boss.edits.v1.${template}`;
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
  const [resetState, setResetState] = useState<"idle" | "confirm" | "done">("idle");

  useEffect(() => {
    fetchBossInfo()
      .then(setInfo)
      .catch(() => {});
  }, []);
  useEffect(() => setUrl(settings.boss_url ?? ""), [settings.boss_url]);
  useEffect(() => setResetState("idle"), [settings.boss_template]);

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
      } else {
        await uploadAsset("text", file.name, await readText(file));
        await resetEdits(TEXT_EDIT_KEY).catch(() => {}); // 새 글을 불러오면 그 글부터
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

  const remove = async (kind: AssetKind, fallback: BossTemplate | null) => {
    setError("");
    try {
      await removeAsset(kind);
      if (kind === "sheet") clearMyFile();
      setInfo(await fetchBossInfo().catch(() => cachedInfo()));
      onFileChanged();
      if (fallback && settings.boss_template === fallback) await save({ boss_template: "weekly" });
    } catch (caught) {
      setError(errorText(caught));
    }
  };

  const resetKey = editKey(settings.boss_template, info);
  const reset = async () => {
    if (!resetKey) return;
    if (resetState !== "confirm") {
      setResetState("confirm");
      return;
    }
    try {
      await resetEdits(resetKey);
      setResetState("done");
      onFileChanged();
    } catch {
      setError("되돌리지 못했어요. 잠시 후 다시 해 주세요.");
      setResetState("idle");
    }
  };

  const choice = (id: BossTemplate, label: ReactNode, disabled = false, extra?: ReactNode) => (
    <div key={id} className="boss-choice-block">
      <label className={disabled ? "boss-choice boss-choice-off" : "boss-choice"}>
        <input
          type="radio"
          name="boss-template"
          checked={settings.boss_template === id}
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
      <input type="file" accept={accept} hidden disabled={busy !== null} onChange={(event) => void upload(kind, event, then)} />
    </label>
  );

  return (
    <>
      <h3 className="settings-sub">보여 줄 화면</h3>
      <div className="boss-choices" role="radiogroup" aria-label="위장 화면">
        {TEMPLATE_NAMES.filter((item) => item.id !== "myfile").map((item) => choice(item.id, `표: ${item.name}`))}
        {choice(
          "myfile",
          `내 표 파일${info.sheet ? `: ${info.sheet.name}` : "(아직 없음)"}`,
          !info.sheet,
          <div className="settings-buttons">
            {fileButton("sheet", info.sheet ? "다른 파일 불러오기" : "불러오기(.xlsx, .csv)", ".xlsx,.xlsm,.csv", "myfile")}
            {info.sheet && (
              <button type="button" className="pill-button" onClick={() => void remove("sheet", "myfile")}>
                지우기
              </button>
            )}
          </div>,
        )}
        {choice(
          "image",
          `내 화면 사진${info.image ? `: ${info.image.name}` : "(아직 없음)"}`,
          !info.image,
          <>
            <div className="settings-buttons">
              {fileButton("image", info.image ? "다른 사진 올리기" : "사진 올리기", "image/png,image/jpeg,image/webp,image/gif", "image")}
              {info.image && (
                <button type="button" className="pill-button" onClick={() => void remove("image", "image")}>
                  지우기
                </button>
              )}
            </div>
            {settings.boss_template === "image" && (
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
            <p className="settings-note">평소 쓰는 업무 화면을 전체 화면으로 캡처해 올리면 가장 자연스러워요.</p>
          </>,
        )}
        {choice(
          "text",
          `글 문서(메모장)${info.text ? `: ${info.text.name}` : ""}`,
          false,
          <>
            <div className="settings-buttons">
              {fileButton("text", "글 파일 불러오기(.txt)", ".txt,text/plain", "text")}
              {info.text && (
                <button type="button" className="pill-button" onClick={() => void remove("text", null)}>
                  불러온 글 지우기
                </button>
              )}
            </div>
            <p className="settings-note">위장 화면에서 바로 글을 쓸 수 있고, 쓴 내용은 계정에 저장돼요.</p>
          </>,
        )}
        {choice(
          "url",
          "다른 사이트로 이동",
          false,
          settings.boss_template === "url" ? (
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
                  placeholder="https://로 시작하는 주소(예: 회사 그룹웨어)"
                  onChange={(event) => setUrl(event.target.value)}
                  onBlur={() => {
                    if ((url.trim() || null) !== settings.boss_url) void save({ boss_url: url.trim() || null });
                  }}
                />
              </form>
              <p className="settings-note">
                보스키를 누르면 이 주소로 바로 넘어가요. 돌아오려면 브라우저 뒤로 가기를 누르고, 보던 화면은 다시
                불러와요(쓰던 글은 사라질 수 있어요). 자동 위장은 이 방식에서 동작하지 않아요.
              </p>
            </>
          ) : null,
        )}
      </div>
      {error && <p className="list-error">{error}</p>}
      {resetKey && (
        <div className="settings-buttons">
          <button type="button" className="pill-button" onClick={() => void reset()}>
            {resetState === "confirm"
              ? "한 번 더 누르면 되돌려요"
              : resetState === "done"
                ? "처음 상태로 되돌렸어요"
                : settings.boss_template === "text"
                  ? "쓴 글 처음 상태로 되돌리기"
                  : "표에 고친 내용 되돌리기"}
          </button>
        </div>
      )}
      <p className="settings-note">
        올린 파일과 고친 내용은 계정에 암호화해 저장돼서 다른 브라우저나 PC에서도 그대로 보여요. 엑셀 파일은 이
        브라우저에서 읽고 표 내용만 저장해요.
      </p>
    </>
  );
}

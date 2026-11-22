// 사진은 보내기 전에 브라우저에서 줄인다(서버 CPU·송신량 아끼기). 기술 설계서 9장.
// - 긴 쪽 2,000px
// - JPEG·WebP는 다시 저장해 위치 정보 같은 EXIF를 지운다
// - 큰 PNG(1.5MB 넘음, 화면 캡처 등)는 WebP로 다시 저장(투명한 곳은 그대로)
// - GIF(움직임), HEIC 등은 그대로. 보내는 사람이 '원본으로 보내기'를 고르면 원본(Composer)

const MAX_SIDE = 2000;
const QUALITY = 0.85;
const BIG_PNG = 1.5 * 1024 * 1024;

async function loadBitmap(file: File): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return null;
  }
}

export async function prepareImage(file: File): Promise<File> {
  const type = file.type;
  const reencode = type === "image/jpeg" || type === "image/webp";
  if (!reencode && type !== "image/png") return file;
  const bitmap = await loadBitmap(file);
  if (!bitmap) return file;
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const bigPng = type === "image/png" && file.size > BIG_PNG;
  if (scale === 1 && !reencode && !bigPng) {
    bitmap.close();
    return file; // 작은 PNG는 그대로(화질 유지)
  }
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    return file;
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const outType = bigPng ? "image/webp" : type;
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, outType, QUALITY));
  // WebP로 저장하지 못하는 브라우저면 PNG로 나오는데, 그때는 줄인 크기만 쓴다
  if (!blob || blob.size >= file.size) return file;
  const name = blob.type === "image/webp" && type === "image/png" ? file.name.replace(/\.png$/i, ".webp") : file.name;
  return new File([blob], name, { type: blob.type || type, lastModified: Date.now() });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// 사진은 보내기 전에 브라우저에서 줄인다(서버 CPU·송신량 아끼기). 기술 설계서 9장.
// - 긴 쪽 2,000px
// - JPEG·WebP는 다시 저장해 위치 정보 같은 EXIF를 지운다
// - GIF(움직임)·HEIC 등은 그대로

const MAX_SIDE = 2000;
const QUALITY = 0.85;

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
  if (scale === 1 && !reencode) {
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
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, QUALITY));
  if (!blob) return file;
  return new File([blob], file.name, { type, lastModified: Date.now() });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

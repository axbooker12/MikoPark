// Client-side file helpers for the composer.

/** Longest image edge the newest Claude models read at full detail. */
const MAX_IMAGE_EDGE = 2576;
/** The API's per-image limit is 5 MB; stay under it. */
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;
const RASTER = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Shrinks large photos so agents can see them, and converts formats Claude can't read
 * (like iPhone HEIC photos) to JPEG when the browser can decode them. Anything else passes through.
 */
export async function prepareImage(file: File): Promise<{ blob: Blob; name: string; type: string }> {
  const passthrough = { blob: file as Blob, name: file.name, type: file.type || "application/octet-stream" };
  if (!file.type.startsWith("image/") || file.type === "image/gif" || file.type === "image/svg+xml") return passthrough;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return passthrough; // the browser can't decode it; upload as-is
  }
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  if (RASTER.has(file.type) && scale === 1 && file.size <= MAX_IMAGE_BYTES) {
    bitmap.close();
    return passthrough;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const keepPng = file.type === "image/png" && scale < 1;
  const type = keepPng ? "image/png" : "image/jpeg";
  let blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, 0.88));
  if (blob && blob.size > MAX_IMAGE_BYTES && type === "image/png") blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.85));
  if (!blob) return passthrough;
  const name = blob.type === "image/jpeg" && !/\.jpe?g$/i.test(file.name) ? file.name.replace(/\.[^.]+$/, "") + ".jpg" : file.name;
  return { blob, name, type: blob.type };
}

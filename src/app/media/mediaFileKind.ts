type MediaFileKind = "image" | "audio";

const IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "jfif", "jpeg", "jpg", "png", "svg", "webp"]);
const AUDIO_EXTENSIONS = new Set(["aac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav", "webm"]);

/** MIME情報がないローカルファイルも拡張子から素材種別を判定する */
export function detectMediaFileKind(file: Pick<File, "name" | "type">): MediaFileKind | null {
  const mime = file.type.toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";

  const extension = file.name.toLowerCase().match(/\.([^.]+)$/)?.[1] ?? "";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  return null;
}

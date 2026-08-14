import { Texture } from "pixi.js";

export interface GifFrameLike {
  duration?: number | null;
  displayWidth?: number;
  displayHeight?: number;
  codedWidth?: number;
  codedHeight?: number;
  close?: () => void;
}

export interface GifDecoderLike {
  tracks: {
    ready: Promise<void>;
    selectedTrack?: { frameCount?: number } | null;
  };
  decode(options: { frameIndex: number; completeFramesOnly?: boolean }): Promise<{ image: GifFrameLike }>;
  close?: () => void;
}

type GifDecoderConstructor = {
  new (init: { data: Uint8Array; type: string; preferAnimation?: boolean }): GifDecoderLike;
  isTypeSupported?: (type: string) => Promise<boolean>;
};

export interface LoadedImage {
  texture: Texture;
  objectUrl: string;
  preview: string;
  isGif: boolean;
  gifDecoder?: GifDecoderLike;
  gifCanvas?: HTMLCanvasElement;
  gifFrameCount: number;
  gifNextAt: number;
}

/** パネル表示用に画像を縮小して軽量なWebPへ変換する */
export async function createPanelPreview(file: File, maxSize = 384): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const ratio = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
  canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
  const context = canvas.getContext("2d", { alpha: true });
  if (context) {
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  }
  bitmap.close();
  return canvas.toDataURL("image/webp", 0.72);
}

/** Blob URLをブラウザでデコードしてPixiJSへ渡せる画像要素を返す */
async function decodeImageElement(objectUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener("error", () => reject(new Error("Image decode failed")), { once: true });
    image.src = objectUrl;
  });
}

/** 画像ファイルを静止画またはWebCodecs GIFとして読み込む */
export async function loadImageFile(file: File): Promise<LoadedImage> {
  const objectUrl = URL.createObjectURL(file);
  let gifDecoder: GifDecoderLike | undefined;

  try {
    const preview = await createPanelPreview(file);
    const isGif = file.type === "image/gif" || /\.gif$/i.test(file.name);
    if (!isGif) {
      const image = await decodeImageElement(objectUrl);
      return {
        // Assetsは拡張子のないBlob URLから形式を判定できないためデコード済み要素を直接渡す
        texture: Texture.from(image),
        objectUrl,
        preview,
        isGif: false,
        gifFrameCount: 1,
        gifNextAt: 0,
      };
    }

    const Decoder = (globalThis as unknown as { ImageDecoder?: GifDecoderConstructor }).ImageDecoder;
    if (!Decoder) throw new Error("ImageDecoder is unavailable in this browser");
    const supported = Decoder.isTypeSupported ? await Decoder.isTypeSupported("image/gif") : true;
    if (!supported) throw new Error("ImageDecoder does not support image/gif");

    gifDecoder = new Decoder({
      data: new Uint8Array(await file.arrayBuffer()),
      type: "image/gif",
      preferAnimation: true,
    });
    await gifDecoder.tracks.ready;
    const gifFrameCount = Math.max(1, Number(gifDecoder.tracks.selectedTrack?.frameCount) || 1);
    const first = await gifDecoder.decode({ frameIndex: 0, completeFramesOnly: true });
    const frame = first.image;
    const sourceWidth = frame.displayWidth ?? frame.codedWidth ?? 1;
    const sourceHeight = frame.displayHeight ?? frame.codedHeight ?? 1;
    // GIFは毎フレームCanvasへ転送するため長辺を1920pxまでに抑える
    const ratio = Math.min(1, 1920 / Math.max(sourceWidth, sourceHeight));
    const gifCanvas = document.createElement("canvas");
    gifCanvas.width = Math.max(1, Math.round(sourceWidth * ratio));
    gifCanvas.height = Math.max(1, Math.round(sourceHeight * ratio));
    const context = gifCanvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("GIF canvas unavailable");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(frame as unknown as CanvasImageSource, 0, 0, gifCanvas.width, gifCanvas.height);
    const gifNextAt = performance.now() + getGifFrameDurationMs(frame);
    frame.close?.();

    return {
      texture: Texture.from(gifCanvas),
      objectUrl,
      preview,
      isGif: true,
      gifDecoder,
      gifCanvas,
      gifFrameCount,
      gifNextAt,
    };
  } catch (error) {
    // 読み込み失敗時にBlob URLとデコーダーを残さない
    URL.revokeObjectURL(objectUrl);
    try { gifDecoder?.close?.(); } catch { /* デコーダーが既に閉じていれば何もしない */ }
    throw error;
  }
}

/** WebCodecsのマイクロ秒単位フレーム時間を安全なミリ秒へ変換する */
export function getGifFrameDurationMs(frame: GifFrameLike): number {
  const durationUs = Number(frame.duration);
  // 異常なメタデータで更新が暴走または長時間停止しない範囲へ収める
  return Number.isFinite(durationUs) && durationUs > 0
    ? Math.max(16, Math.min(10_000, durationUs / 1000))
    : 100;
}

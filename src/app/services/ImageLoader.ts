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
  gifImage?: HTMLImageElement;
  gifCanvas?: HTMLCanvasElement;
  gifFrameCount: number;
  gifNextAt: number;
}

/** パネル表示用に画像を縮小して軽量なWebPへ変換する */
export async function createPanelPreview(file: File, maxSize = 384): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const { canvas, context } = createScaledCanvas(bitmap.width, bitmap.height, maxSize);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/webp", 0.72);
  } finally {
    // Canvas変換で例外が出てもデコード済みBitmapを残さない
    bitmap.close();
  }
}

/** 指定寸法を長辺上限へ収めた高品質Canvasを作る */
function createScaledCanvas(width: number, height: number, maxSize: number): {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
} {
  const ratio = Math.min(1, maxSize / Math.max(1, width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("Image canvas unavailable");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  return { canvas, context };
}

/** Blob URLをブラウザでデコードしてPixiJSへ渡せる画像要素を返す */
async function decodeImageElement(objectUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    /** 完了後に不要な反対側のイベント監視も解除する */
    const cleanup = () => {
      image.removeEventListener("load", handleLoad);
      image.removeEventListener("error", handleError);
    };
    /** 読み込み済み画像を呼び出し元へ返す */
    const handleLoad = () => {
      cleanup();
      resolve(image);
    };
    /** ブラウザでデコードできない画像を失敗として返す */
    const handleError = () => {
      cleanup();
      reject(new Error("Image decode failed"));
    };
    image.addEventListener("load", handleLoad);
    image.addEventListener("error", handleError);
    image.src = objectUrl;
  });
}

/** WebCodecs非対応時にブラウザ標準GIFをCanvasテクスチャとして読み込む */
async function loadNativeGif(objectUrl: string, preview: string): Promise<LoadedImage> {
  const gifImage = await decodeImageElement(objectUrl);
  const { canvas, context } = createScaledCanvas(gifImage.naturalWidth, gifImage.naturalHeight, 1920);
  context.drawImage(gifImage, 0, 0, canvas.width, canvas.height);
  return {
    texture: Texture.from(canvas),
    objectUrl,
    preview,
    isGif: true,
    gifImage,
    gifCanvas: canvas,
    // ネイティブGIFから総フレーム数は取得できないため0を未知数として扱う
    gifFrameCount: 0,
    gifNextAt: performance.now() + 1000 / 30,
  };
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
    if (Decoder) {
      try {
        const supported = Decoder.isTypeSupported ? await Decoder.isTypeSupported("image/gif") : true;
        if (supported) {
          gifDecoder = new Decoder({
            data: new Uint8Array(await file.arrayBuffer()),
            type: "image/gif",
            preferAnimation: true,
          });
          await gifDecoder.tracks.ready;
          const gifFrameCount = Math.max(1, Number(gifDecoder.tracks.selectedTrack?.frameCount) || 1);
          const first = await gifDecoder.decode({ frameIndex: 0, completeFramesOnly: true });
          const frame = first.image;
          try {
            const sourceWidth = frame.displayWidth ?? frame.codedWidth ?? 1;
            const sourceHeight = frame.displayHeight ?? frame.codedHeight ?? 1;
            // GIFは毎フレームCanvasへ転送するため長辺を1920pxまでに抑える
            const { canvas: gifCanvas, context } = createScaledCanvas(sourceWidth, sourceHeight, 1920);
            context.drawImage(frame as unknown as CanvasImageSource, 0, 0, gifCanvas.width, gifCanvas.height);
            return {
              texture: Texture.from(gifCanvas),
              objectUrl,
              preview,
              isGif: true,
              gifDecoder,
              gifCanvas,
              gifFrameCount,
              gifNextAt: performance.now() + getGifFrameDurationMs(frame),
            };
          } finally {
            frame.close?.();
          }
        }
      } catch {
        // WebCodecsだけが失敗した場合は同じファイルをブラウザ標準デコーダーで再試行する
        try { gifDecoder?.close?.(); } catch { /* デコーダーが既に閉じていれば何もしない */ }
        gifDecoder = undefined;
      }
    }
    return await loadNativeGif(objectUrl, preview);
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

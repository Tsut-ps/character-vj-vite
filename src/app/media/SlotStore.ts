import type { Texture } from "pixi.js";
import { createEmptySlot, type Slot } from "../models/Slot";
import { AudioManager, type DecodedAudio } from "../services/AudioManager";
import { getGifFrameDurationMs, loadImageFile, type LoadedImage } from "../services/ImageLoader";

interface SlotTransform {
  scale: number;
  anchorX: number;
  anchorY: number;
}

interface ImageAssignment {
  texture: Texture;
  preview: string;
  isGif: boolean;
  gifFrameCount: number;
}

interface AudioAssignment {
  name: string;
  trimmedMs: number;
}

/** スロットのメディアと表示補正を一元管理する */
export class SlotStore {
  private slots: Slot[];
  private commonTransform: SlotTransform = { scale: 1, anchorX: 0.5, anchorY: 0.5 };
  private resolvedTransforms: SlotTransform[];
  private fitScales: number[];
  private backgroundFitScales: number[];
  private imageAssignmentRevisions: number[];
  private audioAssignmentRevisions: number[];
  private viewportWidth = 1280;
  private viewportHeight = 720;
  private audio = new AudioManager();

  /** 指定数の空スロットを生成する */
  constructor(count = 8) {
    this.slots = Array.from({ length: count }, () => createEmptySlot());
    this.resolvedTransforms = Array.from({ length: count }, () => ({ scale: 1, anchorX: 0.5, anchorY: 0.5 }));
    this.fitScales = Array.from({ length: count }, () => 1);
    this.backgroundFitScales = Array.from({ length: count }, () => 1);
    this.imageAssignmentRevisions = Array.from({ length: count }, () => 0);
    this.audioAssignmentRevisions = Array.from({ length: count }, () => 0);
  }

  /** 指定スロットを読み取り用に返す */
  get(index: number): Slot {
    return this.slots[index] ?? this.slots[0];
  }

  /** 指定スロットに画像または音声があるか返す */
  hasCue(index: number): boolean {
    const slot = this.slots[index];
    return Boolean(slot?.texture || slot?.audioBuffer);
  }

  /** 指定スロットに画像があるか返す */
  hasImage(index: number): boolean {
    return Boolean(this.slots[index]?.texture);
  }

  /** 現在のマスター音量を返す */
  get volume(): number {
    return this.audio.volume;
  }

  /** 指定スロットの確定済み表示変形を返す */
  transformFor(index: number): SlotTransform {
    return this.resolvedTransforms[index] ?? this.resolvedTransforms[0];
  }

  /** 指定スロットの画面フィット率を返す */
  fitScaleFor(index: number): number {
    return this.fitScales[index] ?? 1;
  }

  /** 背景の小型コピー用テクスチャを返す。GIFは現在フレームTextureを全コピーで共有する */
  backgroundTextureFor(index: number): Texture | null {
    const slot = this.get(index);
    if (slot.isGif && slot.texture) return slot.texture;
    return slot.backgroundTexture ?? slot.texture;
  }

  /** 背景用テクスチャの寸法に合わせた画面フィット率を返す */
  backgroundFitScaleFor(index: number): number {
    const slot = this.get(index);
    return slot.isGif ? (this.fitScales[index] ?? 1) : (this.backgroundFitScales[index] ?? 1);
  }

  /** 画面サイズを更新して全画像のフィット率を再計算する */
  resize(width: number, height: number): void {
    this.viewportWidth = width;
    this.viewportHeight = height;
    this.refreshFitScales();
  }

  /** 画像を読み込み指定スロットへ割り当てる */
  async assignImage(
    index: number,
    file: File,
    prepareTexture: (texture: Texture) => Promise<void>,
  ): Promise<ImageAssignment> {
    this.assertSlotIndex(index);
    const revision = ++this.imageAssignmentRevisions[index];
    let loaded: LoadedImage;
    try {
      loaded = await loadImageFile(file);
    } catch (error) {
      if (revision !== this.imageAssignmentRevisions[index]) {
        throw new DOMException("Image assignment was superseded", "AbortError");
      }
      throw error;
    }
    if (revision !== this.imageAssignmentRevisions[index]) {
      this.discardLoadedImage(loaded);
      throw new DOMException("Image assignment was superseded", "AbortError");
    }
    try {
      // 初回キューでGPU転送が発生して引っかからないよう先にアップロードする
      await prepareTexture(loaded.texture);
      if (loaded.backgroundTexture !== loaded.texture) {
        await prepareTexture(loaded.backgroundTexture);
      }
    } catch (error) {
      // GPU転送失敗時は新規リソースだけを解放して現在のスロットを維持する
      this.discardLoadedImage(loaded);
      if (revision !== this.imageAssignmentRevisions[index]) {
        throw new DOMException("Image assignment was superseded", "AbortError");
      }
      throw error;
    }
    if (revision !== this.imageAssignmentRevisions[index]) {
      this.discardLoadedImage(loaded);
      throw new DOMException("Image assignment was superseded", "AbortError");
    }

    // 新しい画像の準備完了後に古いリソースを解放して失敗時の表示を維持する
    const previous = this.get(index);
    this.releaseImageResources(previous);
    this.slots[index] = {
      texture: loaded.texture,
      backgroundTexture: loaded.backgroundTexture,
      name: file.name,
      objectUrl: loaded.objectUrl,
      isGif: loaded.isGif,
      gifDecoder: loaded.gifDecoder,
      gifImage: loaded.gifImage,
      gifCanvas: loaded.gifCanvas,
      gifFrameIndex: 0,
      gifFrameCount: loaded.gifFrameCount,
      gifNextAt: loaded.gifNextAt,
      gifDecoding: false,
      gifActiveUntil: 0,
      // 画像差し替え時も同じスロットの音声と表示補正は維持する
      audioBuffer: previous.audioBuffer,
      audioName: previous.audioName,
      audioStart: previous.audioStart,
      audioDuration: previous.audioDuration,
      scaleOffset: previous.scaleOffset,
      anchorXOffset: previous.anchorXOffset,
      anchorYOffset: previous.anchorYOffset,
    };
    this.refreshFitScales();
    return {
      texture: loaded.texture,
      preview: loaded.preview,
      isGif: loaded.isGif,
      gifFrameCount: loaded.gifFrameCount,
    };
  }

  /** 音声をデコードして指定スロットへ割り当てる */
  async assignAudio(index: number, file: File): Promise<AudioAssignment> {
    this.assertSlotIndex(index);
    const revision = ++this.audioAssignmentRevisions[index];
    let decoded: DecodedAudio;
    try {
      decoded = await this.audio.decode(file);
    } catch (error) {
      if (revision !== this.audioAssignmentRevisions[index]) {
        throw new DOMException("Audio assignment was superseded", "AbortError");
      }
      throw error;
    }
    if (revision !== this.audioAssignmentRevisions[index]) {
      throw new DOMException("Audio assignment was superseded", "AbortError");
    }
    const slot = this.get(index);
    slot.audioBuffer = decoded.buffer;
    slot.audioName = decoded.name;
    slot.audioStart = decoded.start;
    slot.audioDuration = decoded.duration;
    return { name: decoded.name, trimmedMs: decoded.trimmedMs };
  }

  /** 指定スロットの音声を再生する */
  playAudio(index: number, strength = 1): void {
    const slot = this.get(index);
    if (!slot.audioBuffer || slot.audioDuration <= 0) return;
    this.audio.play({
      buffer: slot.audioBuffer,
      start: slot.audioStart,
      duration: slot.audioDuration,
    }, strength);
  }

  /** 音声コンテキストを再開する */
  resumeAudio(): void {
    this.audio.resume();
  }

  /** マスター音量を更新する */
  setVolume(value: number): void {
    this.audio.setVolume(value);
  }

  /** 再生中の音声をすべて停止する */
  stopAudio(): void {
    this.audio.stopAll();
  }

  /** 画像読み込み済みスロットを偏りなく一つ選ぶ */
  randomImageSlot(): number | null {
    const loaded = this.slots.flatMap((slot, index) => slot.texture ? [index] : []);
    if (!loaded.length) return null;
    return loaded[Math.floor(Math.random() * loaded.length)];
  }

  /** GIFを指定時刻までアクティブとして扱う */
  activateGif(index: number, until: number): void {
    const slot = this.get(index);
    if (slot.isGif) slot.gifActiveUntil = Math.max(slot.gifActiveUntil, until);
  }

  /** 前景・ラッチ・背景コピーのいずれかで使用中のGIFだけ次フレームへ進める */
  updateAnimatedGifs(now: number, keepGifLive: (index: number) => boolean): void {
    this.slots.forEach((slot, index) => {
      if (!slot.isGif || !slot.gifCanvas || !slot.texture) return;
      if (!slot.gifDecoder && !slot.gifImage) return;
      const live = now <= slot.gifActiveUntil || keepGifLive(index);
      // 完全に未使用のGIFだけ止め、同じデコーダーの並列decodeも防ぐ
      if (!live || slot.gifDecoding || now < slot.gifNextAt) return;

      if (slot.gifImage) {
        const context = slot.gifCanvas.getContext("2d", { alpha: true });
        if (context) {
          context.clearRect(0, 0, slot.gifCanvas.width, slot.gifCanvas.height);
          context.drawImage(slot.gifImage, 0, 0, slot.gifCanvas.width, slot.gifCanvas.height);
          slot.texture.source.update();
        }
        // ネイティブGIFはフレーム時間を取得できないため描画更新だけ30 FPSへ制限する
        slot.gifNextAt = now + 1000 / 30;
        return;
      }
      if (!slot.gifDecoder || slot.gifFrameCount < 2) return;

      slot.gifDecoding = true;
      const nextFrame = (slot.gifFrameIndex + 1) % Math.max(1, slot.gifFrameCount);
      void slot.gifDecoder.decode({ frameIndex: nextFrame, completeFramesOnly: true }).then(({ image }) => {
        try {
          // decode待ちの間に同じスロットが差し替わった場合、破棄済みTextureへ書き込まない
          if (this.slots[index] !== slot || !slot.gifCanvas || !slot.texture) return;
          const context = slot.gifCanvas.getContext("2d", { alpha: true });
          if (context) {
            context.clearRect(0, 0, slot.gifCanvas.width, slot.gifCanvas.height);
            context.drawImage(image as unknown as CanvasImageSource, 0, 0, slot.gifCanvas.width, slot.gifCanvas.height);
            // Canvasの内容変更をPixiJS側のGPUテクスチャへ通知する
            const source = slot.texture.source as unknown as { update?: () => void };
            source.update?.();
          }
          slot.gifFrameIndex = nextFrame;
          slot.gifNextAt = performance.now() + getGifFrameDurationMs(image);
        } finally {
          // drawImageやGPU更新が失敗してもVideoFrame相当のリソースを必ず解放する
          image.close?.();
        }
      }).catch((error) => {
        // 差し替えやdestroyに伴う旧decoderの失敗は通常系なので警告を出さない
        if (this.slots[index] !== slot) return;
        console.warn("GIF frame decode failed", error);
        slot.gifNextAt = performance.now() + 100;
      }).finally(() => {
        if (this.slots[index] === slot) slot.gifDecoding = false;
      });
    });
  }

  /** 全体または指定スロットだけの表示サイズを調整して確定値を返す */
  adjustScale(index: number, delta: number, individual: boolean): number {
    const slot = this.get(index);
    if (individual) {
      const current = this.transformFor(index).scale;
      const next = Math.max(0.35, Math.min(2.5, current + delta));
      // 共通値が後から変わっても個別差分を維持できるよう補正量を保存する
      slot.scaleOffset = next - this.commonTransform.scale;
      this.refreshTransforms();
      return next;
    }
    this.commonTransform.scale = Math.max(0.35, Math.min(2.5, this.commonTransform.scale + delta));
    this.refreshTransforms();
    return this.commonTransform.scale;
  }

  /** 全体または指定スロットだけの基準位置を調整して確定値を返す */
  moveAnchor(index: number, dx: number, dy: number, individual: boolean): SlotTransform {
    const slot = this.get(index);
    if (individual) {
      const current = this.transformFor(index);
      const nextX = Math.max(0.15, Math.min(0.85, current.anchorX + dx));
      const nextY = Math.max(0.15, Math.min(0.85, current.anchorY + dy));
      slot.anchorXOffset = nextX - this.commonTransform.anchorX;
      slot.anchorYOffset = nextY - this.commonTransform.anchorY;
      this.refreshTransforms();
      return this.transformFor(index);
    }
    this.commonTransform.anchorX = Math.max(0.15, Math.min(0.85, this.commonTransform.anchorX + dx));
    this.commonTransform.anchorY = Math.max(0.15, Math.min(0.85, this.commonTransform.anchorY + dy));
    this.refreshTransforms();
    return this.commonTransform;
  }

  /** 全スロットのメディアリソースと再生中音声を解放する */
  destroy(): void {
    // 読み込み完了待ちの旧処理が破棄後にスロットを書き換えないよう世代を進める
    this.imageAssignmentRevisions = this.imageAssignmentRevisions.map((revision) => revision + 1);
    this.audioAssignmentRevisions = this.audioAssignmentRevisions.map((revision) => revision + 1);
    this.audio.destroy();
    for (const slot of this.slots) this.releaseImageResources(slot);
    // VJAppがHMR等で参照されたままでもAudioBufferやCanvasを保持し続けない
    this.slots = this.slots.map(() => createEmptySlot());
    this.fitScales.fill(1);
    this.backgroundFitScales.fill(1);
  }

  /** 共通値とスロット別補正から各表示変形を再計算する */
  private refreshTransforms(): void {
    for (let index = 0; index < this.slots.length; index += 1) {
      const slot = this.slots[index];
      const resolved = this.resolvedTransforms[index];
      // 完全な画面外化や極端な拡大を避けライブ中に復帰できる範囲へ制限する
      resolved.scale = Math.max(0.35, Math.min(2.5, this.commonTransform.scale + slot.scaleOffset));
      resolved.anchorX = Math.max(0.15, Math.min(0.85, this.commonTransform.anchorX + slot.anchorXOffset));
      resolved.anchorY = Math.max(0.15, Math.min(0.85, this.commonTransform.anchorY + slot.anchorYOffset));
    }
  }

  /** 各画像が画面内へ収まる基準スケールを再計算する */
  private refreshFitScales(): void {
    for (let index = 0; index < this.slots.length; index += 1) {
      const texture = this.slots[index].texture;
      // 端へ密着すると動きが見切れるため6%の余白を残す
      this.fitScales[index] = texture
        ? Math.min(
          this.viewportWidth / Math.max(1, texture.width),
          this.viewportHeight / Math.max(1, texture.height),
        ) * 0.94
        : 1;
      const backgroundTexture = this.backgroundTextureFor(index);
      this.backgroundFitScales[index] = backgroundTexture
        ? Math.min(
          this.viewportWidth / Math.max(1, backgroundTexture.width),
          this.viewportHeight / Math.max(1, backgroundTexture.height),
        ) * 0.94
        : 1;
    }
  }

  /** スロットが保持するBlob URLとGIFデコーダーを解放する */
  private releaseImageResources(slot: Slot): void {
    if (slot.objectUrl) URL.revokeObjectURL(slot.objectUrl);
    try { slot.gifDecoder?.close?.(); } catch { /* デコーダーが既に閉じていれば何もしない */ }
    if (slot.gifImage) {
      // native GIFのデコード済みフレームやBlob参照をブラウザが早めに回収できるよう切り離す
      slot.gifImage.removeAttribute("src");
    }
    // 素材差し替えを繰り返してもGPUテクスチャが残り続けないよう明示破棄する
    const mainTexture = slot.texture;
    const backgroundTexture = slot.backgroundTexture;
    if (backgroundTexture && backgroundTexture !== mainTexture) {
      backgroundTexture.destroy(true);
    }
    mainTexture?.destroy(true);
    // 旧Slotオブジェクトを非同期処理が一時参照していても大きなリソースを保持しない
    slot.texture = null;
    slot.backgroundTexture = null;
    slot.objectUrl = undefined;
    slot.gifDecoder = undefined;
    slot.gifImage = undefined;
    slot.gifCanvas = undefined;
    slot.isGif = false;
    slot.gifFrameIndex = 0;
    slot.gifFrameCount = 1;
    slot.gifNextAt = 0;
    slot.gifDecoding = false;
    slot.gifActiveUntil = 0;
  }

  /** 未割り当ての画像リソースをGPUを含めて破棄する */
  private discardLoadedImage(loaded: LoadedImage): void {
    if (loaded.backgroundTexture !== loaded.texture) {
      loaded.backgroundTexture.destroy(true);
    }
    loaded.texture.destroy(true);
    if (loaded.objectUrl) URL.revokeObjectURL(loaded.objectUrl);
    try { loaded.gifDecoder?.close?.(); } catch { /* デコーダーが既に閉じていれば何もしない */ }
    if (loaded.gifImage) {
      loaded.gifImage.removeAttribute("src");
    }
  }

  /** 書き込み先が存在するスロット番号か検証する */
  private assertSlotIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.slots.length) {
      throw new RangeError(`Slot index out of range: ${index}`);
    }
  }
}

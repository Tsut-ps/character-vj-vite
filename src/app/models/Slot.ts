import type { Texture } from "pixi.js";
import type { GifDecoderLike } from "../services/ImageLoader";

export interface Slot {
  texture: Texture | null;
  name: string;
  objectUrl?: string;
  isGif: boolean;
  gifDecoder?: GifDecoderLike;
  gifImage?: HTMLImageElement;
  gifCanvas?: HTMLCanvasElement;
  gifFrameIndex: number;
  gifFrameCount: number;
  gifNextAt: number;
  gifDecoding: boolean;
  gifActiveUntil: number;
  audioBuffer: AudioBuffer | null;
  audioName: string;
  audioStart: number;
  audioDuration: number;
  scaleOffset: number;
  anchorXOffset: number;
  anchorYOffset: number;
}

/** 未割り当て状態のスロットを生成する */
export function createEmptySlot(): Slot {
  return {
    texture: null,
    name: "empty",
    isGif: false,
    gifFrameIndex: 0,
    gifFrameCount: 1,
    gifNextAt: 0,
    gifDecoding: false,
    gifActiveUntil: 0,
    audioBuffer: null,
    audioName: "",
    audioStart: 0,
    audioDuration: 0,
    scaleOffset: 0,
    anchorXOffset: 0,
    anchorYOffset: 0,
  };
}

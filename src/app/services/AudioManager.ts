export interface DecodedAudio {
  buffer: AudioBuffer;
  name: string;
  start: number;
  duration: number;
  trimmedMs: number;
}

export interface PlayableAudio {
  buffer: AudioBuffer;
  start: number;
  duration: number;
}

interface TrimRange {
  start: number;
  duration: number;
  trimmedMs: number;
}

/** Web Audioの初期化とデコードと再生を一元管理する */
export class AudioManager {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private volumeValue = 1;
  private activeSources = new Set<AudioBufferSourceNode>();

  /** 現在のマスター音量を返す */
  get volume(): number {
    return this.volumeValue;
  }

  /** ブラウザに停止された音声コンテキストを再開する */
  resume(): void {
    if (!this.context) return;
    if (this.context.state === "suspended") void this.context.resume();
  }

  /** 音声ファイルをデコードして無音区間を除いた情報を返す */
  async decode(file: File): Promise<DecodedAudio> {
    const context = this.ensureContext();
    this.resume();
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    const trim = this.findTrimRange(buffer);
    return {
      buffer,
      name: file.name,
      start: trim.start,
      duration: trim.duration,
      trimmedMs: trim.trimmedMs,
    };
  }

  /** 音声を入力強度に応じた音量で再生する */
  play(audio: PlayableAudio, strength = 1): void {
    if (audio.duration <= 0) return;
    const context = this.ensureContext();
    this.resume();

    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = audio.buffer;
    source.connect(gain);
    gain.connect(this.masterGain ?? context.destination);

    const now = context.currentTime;
    const duration = Math.min(audio.duration, audio.buffer.duration - audio.start);
    const level = Math.max(0.05, Math.min(1.25, strength));
    // 切り出し境界のクリックノイズを抑えつつ短音を潰さない長さでフェードする
    const fade = Math.min(0.003, duration * 0.2);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(level, now + fade);
    if (duration > fade * 2) gain.gain.setValueAtTime(level, now + duration - fade);
    gain.gain.linearRampToValueAtTime(0, now + duration);

    this.activeSources.add(source);
    source.addEventListener("ended", () => this.activeSources.delete(source), { once: true });
    source.start(now, audio.start, duration);
  }

  /** マスター音量を0から4の範囲で更新する */
  setVolume(value: number): void {
    this.volumeValue = Math.max(0, Math.min(4, value));
    if (!this.masterGain || !this.context) return;

    const now = this.context.currentTime;
    this.masterGain.gain.cancelScheduledValues(now);
    // 再生中の変更で不連続なクリックノイズが出ないよう短く平滑化する
    this.masterGain.gain.setTargetAtTime(this.volumeValue, now, 0.008);
  }

  /** 再生中の音声をすべて停止する */
  stopAll(): void {
    for (const source of this.activeSources) {
      try { source.stop(); } catch { /* 停止済みなら何もしない */ }
    }
    this.activeSources.clear();
  }

  /** 必要になるまで生成しない音声コンテキストを返す */
  private ensureContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: "interactive" });
      this.masterGain = this.context.createGain();
      this.masterGain.gain.value = this.volumeValue;
      this.masterGain.connect(this.context.destination);
    }
    return this.context;
  }

  /** 音声の先頭と末尾にある無音を除いた再生範囲を求める */
  private findTrimRange(buffer: AudioBuffer): TrimRange {
    const frames = buffer.length;
    if (!frames) return { start: 0, duration: 0, trimmedMs: 0 };

    let peak = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let index = 0; index < frames; index += 1) {
        peak = Math.max(peak, Math.abs(data[index]));
      }
    }
    if (peak < 1e-7) return { start: 0, duration: buffer.duration, trimmedMs: 0 };

    // 小さいSFXを残しつつディザやノイズを有音扱いしないよう相対閾値と絶対下限を併用する
    const threshold = Math.max(0.0005, peak * 0.003);
    let first = frames;
    let last = -1;
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const data = buffer.getChannelData(channel);
      let channelFirst = 0;
      while (channelFirst < frames && Math.abs(data[channelFirst]) < threshold) channelFirst += 1;
      let channelLast = frames - 1;
      while (channelLast >= 0 && Math.abs(data[channelLast]) < threshold) channelLast -= 1;
      first = Math.min(first, channelFirst);
      last = Math.max(last, channelLast);
    }
    if (last < first) return { start: 0, duration: buffer.duration, trimmedMs: 0 };

    // 急な切断でクリックノイズが出ないよう有音区間の前後へ3ms残す
    const paddingFrames = Math.round(buffer.sampleRate * 0.003);
    first = Math.max(0, first - paddingFrames);
    last = Math.min(frames - 1, last + paddingFrames);
    const start = first / buffer.sampleRate;
    const duration = Math.max(1 / buffer.sampleRate, (last - first + 1) / buffer.sampleRate);
    return {
      start,
      duration,
      trimmedMs: Math.max(0, (buffer.duration - duration) * 1000),
    };
  }
}

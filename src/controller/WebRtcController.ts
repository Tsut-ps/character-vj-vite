import {
  parseRtcDataMessage,
  type ControllerRtcSignal,
  type RemoteConnectionMode,
  type RemoteEnvelope,
  type RemoteIceCandidate,
  type RemoteIceServers,
  type RemotePath,
  type ServerMessage,
} from "../app/remote/RemoteProtocol.ts";
import {
  createRemoteRtcConfiguration,
  detectRemoteIcePath,
  serializeRemoteIceCandidate,
} from "../app/remote/WebRtcConfig.ts";
import type { RtcPeerConnectionFactory } from "../app/remote/WebRtcHost.ts";

const MAX_PENDING_ICE_CANDIDATES = 64;

export interface WebRtcControllerEvents {
  sendSignal(message: ControllerRtcSignal): boolean;
  onState(connected: boolean, path: RemotePath): void;
}

/** Controller側の単一Host peerとDataChannelを管理する */
export class WebRtcController {
  private readonly events: WebRtcControllerEvents;
  private readonly peerFactory: RtcPeerConnectionFactory;
  private connection: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private rtcSessionId: string | null = null;
  private answerSent = false;
  private connected = false;
  private path: RemotePath = "UNKNOWN";
  private mode: RemoteConnectionMode = "ws";
  private iceServers: RemoteIceServers = [];
  private configurationReady = false;
  private pendingOffer: Extract<ServerMessage, { type: "rtcOffer" }> | null = null;
  private readonly preConnectionCandidates = new Map<string, RemoteIceCandidate[]>();
  private readonly pendingLocalCandidates: RemoteIceCandidate[] = [];
  private readonly pendingRemoteCandidates: RemoteIceCandidate[] = [];
  private readonly pathTimers: ReturnType<typeof setTimeout>[] = [];

  constructor(events: WebRtcControllerEvents, peerFactory: RtcPeerConnectionFactory = (configuration) => new RTCPeerConnection(configuration)) {
    this.events = events;
    this.peerFactory = peerFactory;
  }

  /** TURN取得待ちを含めHost指定modeへの切替開始を通知する */
  prepareMode(mode: RemoteConnectionMode): void {
    this.mode = mode;
    this.configurationReady = mode === "ws";
    this.closePeerOnly();
    if (mode === "ws") {
      this.pendingOffer = null;
      this.preConnectionCandidates.clear();
    }
  }

  /** Hostが決めたmodeと短期ICE設定を適用し待機Offerを再開する */
  setMode(mode: RemoteConnectionMode, iceServers: RemoteIceServers = []): void {
    const changed = this.mode !== mode || JSON.stringify(this.iceServers) !== JSON.stringify(iceServers);
    this.mode = mode;
    this.iceServers = [...iceServers];
    this.configurationReady = true;
    if (mode === "ws") {
      this.closePeerOnly();
      this.pendingOffer = null;
      this.preConnectionCandidates.clear();
      return;
    }
    if (changed) this.closePeerOnly();
    const pending = this.pendingOffer;
    this.pendingOffer = null;
    if (pending) void this.handleOffer(pending);
  }

  /** Host offerから現在modeのpeerを作りanswerをsignalingへ返す */
  async handleOffer(message: Extract<ServerMessage, { type: "rtcOffer" }>): Promise<void> {
    if (!this.configurationReady) {
      this.pendingOffer = message;
      return;
    }
    if (this.mode === "ws") return;
    this.closePeerOnly();
    this.rtcSessionId = message.rtcSessionId;
    this.pendingRemoteCandidates.push(...(this.preConnectionCandidates.get(message.rtcSessionId) ?? []));
    this.preConnectionCandidates.delete(message.rtcSessionId);
    const connection = this.peerFactory(createRemoteRtcConfiguration(this.mode, this.iceServers));
    this.connection = connection;
    this.answerSent = false;
    this.path = "UNKNOWN";
    connection.addEventListener("datachannel", (event) => this.acceptChannel(connection, event.channel));
    connection.addEventListener("icecandidate", (event) => this.sendCandidate(connection, event.candidate));
    connection.addEventListener("connectionstatechange", () => this.handleConnectionState(connection));
    try {
      await connection.setRemoteDescription({ type: "offer", sdp: message.sdp });
      await this.flushRemoteCandidates(connection);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      const sdp = connection.localDescription?.sdp;
      if (!sdp || this.connection !== connection || this.rtcSessionId !== message.rtcSessionId || !this.events.sendSignal({
        v: 1,
        type: "rtcAnswer",
        rtcSessionId: message.rtcSessionId,
        sdp,
      })) {
        this.closePeerOnly();
        return;
      }
      this.answerSent = true;
      for (const candidate of this.pendingLocalCandidates.splice(0)) {
        this.events.sendSignal({ v: 1, type: "rtcIceCandidate", rtcSessionId: message.rtcSessionId, candidate });
      }
    } catch {
      this.closePeerOnly();
    }
  }

  /** 現在negotiation世代のHost ICEだけを適用する */
  async handleCandidate(message: Extract<ServerMessage, { type: "rtcIceCandidate" }>): Promise<void> {
    const connection = this.connection;
    if (!this.configurationReady) {
      const pending = this.preConnectionCandidates.get(message.rtcSessionId) ?? [];
      if (pending.length < MAX_PENDING_ICE_CANDIDATES) {
        pending.push(message.candidate);
        this.preConnectionCandidates.set(message.rtcSessionId, pending);
      }
      return;
    }
    if (!connection) return;
    if (this.rtcSessionId !== message.rtcSessionId || this.mode === "ws") return;
    if (!connection.remoteDescription) {
      if (this.pendingRemoteCandidates.length >= MAX_PENDING_ICE_CANDIDATES) {
        this.closePeerOnly();
        return;
      }
      this.pendingRemoteCandidates.push(message.candidate);
      return;
    }
    try {
      await connection.addIceCandidate(message.candidate);
    } catch {
      this.closePeerOnly();
    }
  }

  /** RemoteEnvelopeをreliable ordered channelへ送る */
  send(envelope: RemoteEnvelope): boolean {
    return this.sendData({ v: 1, type: "remote", envelope });
  }

  close(): void {
    this.mode = this.mode === "ws" ? "ws" : this.mode;
    this.closePeerOnly();
  }

  private acceptChannel(connection: RTCPeerConnection, channel: RTCDataChannel): void {
    if (this.connection !== connection || channel.label !== "remote") {
      channel.close();
      return;
    }
    this.channel?.close();
    this.channel = channel;
    channel.addEventListener("open", () => {
      if (this.connection !== connection || this.channel !== channel) return;
      this.setConnected(true);
      this.schedulePathRefresh(connection);
    });
    channel.addEventListener("close", () => this.handleChannelClosed(channel));
    channel.addEventListener("error", () => this.handleChannelClosed(channel));
    channel.addEventListener("message", (event) => this.handleData(event.data));
  }

  private handleData(data: unknown): void {
    const message = parseRtcDataMessage(data);
    if (!message) return;
    if (message.type === "ping") this.sendData({ v: 1, type: "pong", nonce: message.nonce });
  }

  private sendData(message: unknown): boolean {
    if (!this.channel || this.channel.readyState !== "open") return false;
    try {
      this.channel.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private sendCandidate(connection: RTCPeerConnection, candidate: RTCIceCandidate | null): void {
    if (!candidate || this.connection !== connection || !this.rtcSessionId) return;
    const init = serializeRemoteIceCandidate(candidate);
    if (!this.answerSent) {
      if (this.pendingLocalCandidates.length >= MAX_PENDING_ICE_CANDIDATES) {
        this.closePeerOnly();
        return;
      }
      this.pendingLocalCandidates.push(init);
      return;
    }
    this.events.sendSignal({ v: 1, type: "rtcIceCandidate", rtcSessionId: this.rtcSessionId, candidate: init });
  }

  private handleConnectionState(connection: RTCPeerConnection): void {
    if (this.connection !== connection) return;
    if (connection.connectionState === "failed" || connection.connectionState === "closed") this.closePeerOnly();
  }

  private handleChannelClosed(channel: RTCDataChannel): void {
    if (this.channel !== channel) return;
    this.closePeerOnly();
  }

  private setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    this.events.onState(connected, this.path);
  }

  private schedulePathRefresh(connection: RTCPeerConnection): void {
    const refresh = async (): Promise<void> => {
      if (this.connection !== connection) return;
      const path = await detectRemoteIcePath(connection);
      if (this.connection !== connection || path === this.path) return;
      this.path = path;
      if (this.connected) this.events.onState(true, path);
    };
    void refresh();
    for (const delay of [250, 1_000, 3_000]) this.pathTimers.push(setTimeout(() => void refresh(), delay));
  }

  private async flushRemoteCandidates(connection: RTCPeerConnection): Promise<void> {
    for (const candidate of this.pendingRemoteCandidates.splice(0)) await connection.addIceCandidate(candidate);
  }

  private closePeerOnly(): void {
    const wasConnected = this.connected;
    this.connected = false;
    for (const timer of this.pathTimers.splice(0)) clearTimeout(timer);
    this.pendingLocalCandidates.length = 0;
    this.pendingRemoteCandidates.length = 0;
    this.answerSent = false;
    this.rtcSessionId = null;
    const channel = this.channel;
    const connection = this.connection;
    this.channel = null;
    this.connection = null;
    try { channel?.close(); } catch { /* noop */ }
    try { connection?.close(); } catch { /* noop */ }
    if (wasConnected) this.events.onState(false, this.path);
    this.path = "UNKNOWN";
  }
}

import {
  type ControllerRtcSignal,
  type RemoteEnvelope,
  type RemoteIceCandidate,
  type ServerMessage,
} from "../app/remote/RemoteProtocol.ts";
import { createRemoteRtcConfiguration, serializeRemoteIceCandidate } from "../app/remote/WebRtcConfig.ts";
import type { RtcPeerConnectionFactory } from "../app/remote/WebRtcHost.ts";

const MAX_PENDING_ICE_CANDIDATES = 64;

export interface WebRtcControllerEvents {
  sendSignal(message: ControllerRtcSignal): boolean;
  onState(connected: boolean): void;
}

/** Controller側の単一Host peerとDataChannelを管理する */
export class WebRtcController {
  private readonly events: WebRtcControllerEvents;
  private readonly peerFactory: RtcPeerConnectionFactory;
  private connection: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private answerSent = false;
  private connected = false;
  private readonly pendingLocalCandidates: RemoteIceCandidate[] = [];
  private readonly pendingRemoteCandidates: RemoteIceCandidate[] = [];

  /** signaling callbackとNative WebRTC factoryを接続する */
  constructor(events: WebRtcControllerEvents, peerFactory: RtcPeerConnectionFactory = (configuration) => new RTCPeerConnection(configuration)) {
    this.events = events;
    this.peerFactory = peerFactory;
  }

  /** Host offerからpeerを作りanswerをWebSocket signalingへ返す */
  async handleOffer(message: Extract<ServerMessage, { type: "rtcOffer" }>): Promise<void> {
    const earlyCandidates = this.pendingRemoteCandidates.splice(0);
    this.close();
    this.pendingRemoteCandidates.push(...earlyCandidates);
    const connection = this.peerFactory(createRemoteRtcConfiguration());
    this.connection = connection;
    this.answerSent = false;
    connection.addEventListener("datachannel", (event) => this.acceptChannel(connection, event.channel));
    connection.addEventListener("icecandidate", (event) => this.sendCandidate(connection, event.candidate));
    connection.addEventListener("connectionstatechange", () => this.handleConnectionState(connection));
    try {
      await connection.setRemoteDescription({ type: "offer", sdp: message.sdp });
      await this.flushRemoteCandidates(connection);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      const sdp = connection.localDescription?.sdp;
      if (!sdp || !this.events.sendSignal({ v: 1, type: "rtcAnswer", sdp })) {
        this.close();
        return;
      }
      this.answerSent = true;
      for (const candidate of this.pendingLocalCandidates.splice(0)) {
        this.events.sendSignal({ v: 1, type: "rtcIceCandidate", candidate });
      }
    } catch {
      this.close();
    }
  }

  /** Host ICE candidateをremote description後に適用する */
  async handleCandidate(message: Extract<ServerMessage, { type: "rtcIceCandidate" }>): Promise<void> {
    const connection = this.connection;
    if (!connection || !connection.remoteDescription) {
      if (this.pendingRemoteCandidates.length >= MAX_PENDING_ICE_CANDIDATES) {
        this.close();
        return;
      }
      this.pendingRemoteCandidates.push(message.candidate);
      return;
    }
    try {
      await connection.addIceCandidate(message.candidate);
    } catch {
      this.close();
    }
  }

  /** OPENなreliable ordered DataChannelへRemoteEnvelopeだけを送る */
  send(envelope: RemoteEnvelope): boolean {
    if (!this.channel || this.channel.readyState !== "open" || !this.connected) return false;
    this.channel.send(JSON.stringify(envelope));
    return true;
  }

  /** peerとDataChannelを閉じて接続状態を解放する */
  close(): void {
    const wasConnected = this.connected;
    this.connected = false;
    this.answerSent = false;
    this.pendingLocalCandidates.length = 0;
    this.pendingRemoteCandidates.length = 0;
    const channel = this.channel;
    const connection = this.connection;
    this.channel = null;
    this.connection = null;
    channel?.close();
    connection?.close();
    if (wasConnected) this.events.onState(false);
  }

  /** Hostが作ったremote labelのordered channelだけを採用する */
  private acceptChannel(connection: RTCPeerConnection, channel: RTCDataChannel): void {
    if (
      this.connection !== connection
      || channel.label !== "remote"
      || !channel.ordered
      || channel.maxRetransmits !== null
      || channel.maxPacketLifeTime !== null
    ) {
      channel.close();
      return;
    }
    this.channel?.close();
    this.channel = channel;
    channel.addEventListener("open", () => this.setConnected(channel, true));
    channel.addEventListener("close", () => this.close());
    channel.addEventListener("error", () => this.close());
    if (channel.readyState === "open") this.setConnected(channel, true);
  }

  /** answerより先に生成されたICEを一時保持してsignaling順を守る */
  private sendCandidate(connection: RTCPeerConnection, candidate: RTCIceCandidate | null): void {
    if (!candidate || this.connection !== connection) return;
    const init = serializeRemoteIceCandidate(candidate);
    if (!this.answerSent) {
      if (this.pendingLocalCandidates.length >= MAX_PENDING_ICE_CANDIDATES) {
        this.close();
        return;
      }
      this.pendingLocalCandidates.push(init);
      return;
    }
    this.events.sendSignal({ v: 1, type: "rtcIceCandidate", candidate: init });
  }

  /** failed系connectionを閉じて手動WS選択待ちへ戻す */
  private handleConnectionState(connection: RTCPeerConnection): void {
    if (this.connection !== connection) return;
    if (connection.connectionState === "failed" || connection.connectionState === "disconnected" || connection.connectionState === "closed") this.close();
  }

  /** channel状態を重複通知せずController UIへ渡す */
  private setConnected(channel: RTCDataChannel, connected: boolean): void {
    if (this.channel !== channel || this.connected === connected) return;
    this.connected = connected;
    this.events.onState(connected);
  }

  /** offer前に届いたICEを順番に適用する */
  private async flushRemoteCandidates(connection: RTCPeerConnection): Promise<void> {
    for (const candidate of this.pendingRemoteCandidates.splice(0)) await connection.addIceCandidate(candidate);
  }
}

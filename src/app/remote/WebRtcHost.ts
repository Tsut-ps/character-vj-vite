import {
  parseRemoteEnvelopeMessage,
  type HostClientMessage,
  type RemoteIceCandidate,
  type RemoteEnvelope,
  type ServerMessage,
} from "./RemoteProtocol.ts";
import { createRemoteRtcConfiguration, serializeRemoteIceCandidate } from "./WebRtcConfig.ts";

const MAX_PENDING_ICE_CANDIDATES = 64;

interface HostPeer {
  connection: RTCPeerConnection;
  channel: RTCDataChannel;
  connected: boolean;
  offerSent: boolean;
  pendingLocalCandidates: RemoteIceCandidate[];
  pendingRemoteCandidates: RemoteIceCandidate[];
}

export interface WebRtcHostEvents {
  sendSignal(message: HostClientMessage): boolean;
  onEnvelope(controllerSessionId: string, envelope: RemoteEnvelope): void;
  onState(controllerSessionId: string, connected: boolean): void;
}

export type RtcPeerConnectionFactory = (configuration: RTCConfiguration) => RTCPeerConnection;

export interface RemoteWebRtcHost {
  setEnabled(enabled: boolean, controllerSessionIds: Iterable<string>): void;
  controllerConnected(controllerSessionId: string): void;
  controllerDisconnected(controllerSessionId: string): void;
  handleAnswer(message: Extract<ServerMessage, { type: "rtcAnswer" }>): Promise<void>;
  handleCandidate(message: Extract<ServerMessage, { type: "rtcIceCandidate" }>): Promise<void>;
  destroy(): void;
}

export type WebRtcHostFactory = (events: WebRtcHostEvents) => RemoteWebRtcHost;

/** Hostと各Controllerの1対1 DIRECT peerを管理する */
export class WebRtcHost implements RemoteWebRtcHost {
  private readonly events: WebRtcHostEvents;
  private readonly peerFactory: RtcPeerConnectionFactory;
  private readonly peers = new Map<string, HostPeer>();
  private enabled = false;

  /** signalingとRemoteEnvelope callbackを接続する */
  constructor(events: WebRtcHostEvents, peerFactory: RtcPeerConnectionFactory = (configuration) => new RTCPeerConnection(configuration)) {
    this.events = events;
    this.peerFactory = peerFactory;
  }

  /** DIRECTの有効状態を切り替えて対象Controllerだけpeerを作る */
  setEnabled(enabled: boolean, controllerSessionIds: Iterable<string>): void {
    this.enabled = enabled;
    if (!enabled) {
      this.closeAll();
      return;
    }
    for (const controllerSessionId of controllerSessionIds) this.ensurePeer(controllerSessionId);
  }

  /** DIRECT選択中の新規Controllerへofferを作る */
  controllerConnected(controllerSessionId: string): void {
    if (this.enabled) this.ensurePeer(controllerSessionId);
  }

  /** 切断Controllerのpeerを解放する */
  controllerDisconnected(controllerSessionId: string): void {
    this.closePeer(controllerSessionId);
  }

  /** Controller answerを対応peerへ適用する */
  async handleAnswer(message: Extract<ServerMessage, { type: "rtcAnswer" }>): Promise<void> {
    const peer = this.peers.get(message.controllerSessionId);
    if (!this.enabled || !peer || peer.connection.remoteDescription) return;
    try {
      await peer.connection.setRemoteDescription({ type: "answer", sdp: message.sdp });
      await this.flushRemoteCandidates(peer);
    } catch {
      this.closePeer(message.controllerSessionId);
    }
  }

  /** Controller ICE candidateをremote description後に適用する */
  async handleCandidate(message: Extract<ServerMessage, { type: "rtcIceCandidate" }>): Promise<void> {
    const peer = this.peers.get(message.controllerSessionId);
    if (!this.enabled || !peer) return;
    if (!peer.connection.remoteDescription) {
      if (peer.pendingRemoteCandidates.length >= MAX_PENDING_ICE_CANDIDATES) {
        this.closePeer(message.controllerSessionId);
        return;
      }
      peer.pendingRemoteCandidates.push(message.candidate);
      return;
    }
    try {
      await peer.connection.addIceCandidate(message.candidate);
    } catch {
      this.closePeer(message.controllerSessionId);
    }
  }

  /** session終了時に全peerを閉じる */
  destroy(): void {
    this.enabled = false;
    this.closeAll();
  }

  /** controllerごとに一度だけreliable ordered DataChannelを作る */
  private ensurePeer(controllerSessionId: string): void {
    if (this.peers.has(controllerSessionId)) return;
    const connection = this.peerFactory(createRemoteRtcConfiguration());
    const channel = connection.createDataChannel("remote", { ordered: true });
    const peer: HostPeer = {
      connection,
      channel,
      connected: false,
      offerSent: false,
      pendingLocalCandidates: [],
      pendingRemoteCandidates: [],
    };
    this.peers.set(controllerSessionId, peer);
    channel.addEventListener("open", () => this.setConnected(controllerSessionId, peer, true));
    channel.addEventListener("close", () => this.closePeer(controllerSessionId));
    channel.addEventListener("error", () => this.closePeer(controllerSessionId));
    channel.addEventListener("message", (event) => this.handleData(controllerSessionId, event.data));
    connection.addEventListener("icecandidate", (event) => this.sendCandidate(controllerSessionId, peer, event.candidate));
    connection.addEventListener("connectionstatechange", () => this.handleConnectionState(controllerSessionId, peer));
    void this.createOffer(controllerSessionId, peer);
  }

  /** local description確定後にofferを送り先行ICEを順番に送る */
  private async createOffer(controllerSessionId: string, peer: HostPeer): Promise<void> {
    try {
      const offer = await peer.connection.createOffer();
      await peer.connection.setLocalDescription(offer);
      const sdp = peer.connection.localDescription?.sdp;
      if (!sdp || !this.events.sendSignal({ v: 1, type: "rtcOffer", controllerSessionId, sdp })) {
        this.closePeer(controllerSessionId);
        return;
      }
      peer.offerSent = true;
      for (const candidate of peer.pendingLocalCandidates.splice(0)) {
        this.events.sendSignal({ v: 1, type: "rtcIceCandidate", controllerSessionId, candidate });
      }
    } catch {
      this.closePeer(controllerSessionId);
    }
  }

  /** offerより先に生成されたICEを一時保持してsignaling順を守る */
  private sendCandidate(controllerSessionId: string, peer: HostPeer, candidate: RTCIceCandidate | null): void {
    if (!candidate || this.peers.get(controllerSessionId) !== peer) return;
    const init = serializeRemoteIceCandidate(candidate);
    if (!peer.offerSent) {
      if (peer.pendingLocalCandidates.length >= MAX_PENDING_ICE_CANDIDATES) {
        this.closePeer(controllerSessionId);
        return;
      }
      peer.pendingLocalCandidates.push(init);
      return;
    }
    this.events.sendSignal({ v: 1, type: "rtcIceCandidate", controllerSessionId, candidate: init });
  }

  /** RemoteInputAdapterへ渡す前にDataChannel payloadを検証する */
  private handleData(controllerSessionId: string, data: unknown): void {
    if (!this.enabled) return;
    const envelope = parseRemoteEnvelopeMessage(data);
    if (envelope) this.events.onEnvelope(controllerSessionId, envelope);
  }

  /** channel状態変化を重複通知せずHost UIへ渡す */
  private setConnected(controllerSessionId: string, peer: HostPeer, connected: boolean): void {
    if (this.peers.get(controllerSessionId) !== peer || peer.connected === connected) return;
    peer.connected = connected;
    this.events.onState(controllerSessionId, connected);
  }

  /** failed系connectionを閉じて保持中Cue解放を通知する */
  private handleConnectionState(controllerSessionId: string, peer: HostPeer): void {
    if (peer.connection.connectionState === "failed" || peer.connection.connectionState === "disconnected" || peer.connection.connectionState === "closed") {
      this.closePeer(controllerSessionId);
    }
  }

  /** remote description前に届いたICEを順番に適用する */
  private async flushRemoteCandidates(peer: HostPeer): Promise<void> {
    for (const candidate of peer.pendingRemoteCandidates.splice(0)) await peer.connection.addIceCandidate(candidate);
  }

  /** 単一peerを閉じてconnectedなら解放通知する */
  private closePeer(controllerSessionId: string): void {
    const peer = this.peers.get(controllerSessionId);
    if (!peer) return;
    this.peers.delete(controllerSessionId);
    if (peer.connected) this.events.onState(controllerSessionId, false);
    peer.channel.close();
    peer.connection.close();
  }

  /** 全Controller peerを閉じる */
  private closeAll(): void {
    for (const controllerSessionId of [...this.peers.keys()]) this.closePeer(controllerSessionId);
  }
}

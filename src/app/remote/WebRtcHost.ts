import {
  parseRtcDataMessage,
  type HostClientMessage,
  type RemoteConnectionMode,
  type RemoteEnvelope,
  type RemoteIceCandidate,
  type RemoteIceServers,
  type RemotePath,
  type ServerMessage,
} from "./RemoteProtocol.ts";
import {
  createRemoteRtcConfiguration,
  detectRemoteIcePath,
  serializeRemoteIceCandidate,
} from "./WebRtcConfig.ts";

const MAX_PENDING_ICE_CANDIDATES = 64;
const RTC_PING_INTERVAL_MS = 1_500;
const RTC_PING_TIMEOUT_MS = 10_000;

interface HostPeer {
  connection: RTCPeerConnection;
  channel: RTCDataChannel;
  rtcSessionId: string;
  connected: boolean;
  path: RemotePath;
  offerSent: boolean;
  pendingLocalCandidates: RemoteIceCandidate[];
  pendingRemoteCandidates: RemoteIceCandidate[];
  pendingPings: Map<string, number>;
  pingTimer: ReturnType<typeof setInterval> | null;
  pathTimers: ReturnType<typeof setTimeout>[];
}

export interface WebRtcHostEvents {
  sendSignal(message: HostClientMessage): boolean;
  onEnvelope(controllerSessionId: string, envelope: RemoteEnvelope): void;
  onState(controllerSessionId: string, connected: boolean, path: RemotePath): void;
  onLatency(controllerSessionId: string, rttMs: number): void;
}

export type RtcPeerConnectionFactory = (configuration: RTCConfiguration) => RTCPeerConnection;

export interface RemoteWebRtcHost {
  setMode(mode: RemoteConnectionMode, controllerSessionIds: Iterable<string>, iceServers?: RemoteIceServers): void;
  controllerConnected(controllerSessionId: string): void;
  controllerDisconnected(controllerSessionId: string): void;
  handleAnswer(message: Extract<ServerMessage, { type: "rtcAnswer" }>): Promise<void>;
  handleCandidate(message: Extract<ServerMessage, { type: "rtcIceCandidate" }>): Promise<void>;
  destroy(): void;
}

export type WebRtcHostFactory = (events: WebRtcHostEvents) => RemoteWebRtcHost;

/** Hostと各Controllerの1対1 WebRTC peerをstar topologyで管理する */
export class WebRtcHost implements RemoteWebRtcHost {
  private readonly events: WebRtcHostEvents;
  private readonly peerFactory: RtcPeerConnectionFactory;
  private readonly peers = new Map<string, HostPeer>();
  private mode: RemoteConnectionMode = "ws";
  private iceServers: RemoteIceServers = [];

  constructor(events: WebRtcHostEvents, peerFactory: RtcPeerConnectionFactory = (configuration) => new RTCPeerConnection(configuration)) {
    this.events = events;
    this.peerFactory = peerFactory;
  }

  /** mode変更時は旧peerを全破棄し新しいnegotiation世代を作る */
  setMode(mode: RemoteConnectionMode, controllerSessionIds: Iterable<string>, iceServers: RemoteIceServers = []): void {
    const sameConfig = this.mode === mode && JSON.stringify(this.iceServers) === JSON.stringify(iceServers);
    this.mode = mode;
    this.iceServers = [...iceServers];
    if (mode === "ws") {
      this.closeAll();
      return;
    }
    if (!sameConfig) this.closeAll();

    const allowed = new Set(controllerSessionIds);

    for (const controllerSessionId of [...this.peers.keys()]) {
      if (!allowed.has(controllerSessionId)) {
        this.closePeer(controllerSessionId);
      }
    }

    for (const controllerSessionId of allowed) {
      this.ensurePeer(controllerSessionId);
    }
  }

  controllerConnected(controllerSessionId: string): void {
    if (this.mode !== "ws") this.ensurePeer(controllerSessionId);
  }

  controllerDisconnected(controllerSessionId: string): void {
    this.closePeer(controllerSessionId);
  }

  /** 現在のrtcSessionIdと一致するAnswerだけを適用して古いnegotiationを捨てる */
  async handleAnswer(message: Extract<ServerMessage, { type: "rtcAnswer" }>): Promise<void> {
    const peer = this.peers.get(message.controllerSessionId);
    if (this.mode === "ws" || !peer || peer.rtcSessionId !== message.rtcSessionId || peer.connection.remoteDescription) return;
    try {
      await peer.connection.setRemoteDescription({ type: "answer", sdp: message.sdp });
      await this.flushRemoteCandidates(peer);
    } catch {
      this.closePeer(message.controllerSessionId);
    }
  }

  /** 現在世代のICE candidateだけをremote description後に適用する */
  async handleCandidate(message: Extract<ServerMessage, { type: "rtcIceCandidate" }>): Promise<void> {
    const peer = this.peers.get(message.controllerSessionId);
    if (this.mode === "ws" || !peer || peer.rtcSessionId !== message.rtcSessionId) return;
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

  destroy(): void {
    this.mode = "ws";
    this.closeAll();
  }

  private ensurePeer(controllerSessionId: string): void {
    if (this.mode === "ws" || this.peers.has(controllerSessionId)) return;
    const rtcMode = this.mode;
    const connection = this.peerFactory(createRemoteRtcConfiguration(rtcMode, this.iceServers));
    const channel = connection.createDataChannel("remote", { ordered: true });
    const peer: HostPeer = {
      connection,
      channel,
      rtcSessionId: crypto.randomUUID(),
      connected: false,
      path: "UNKNOWN",
      offerSent: false,
      pendingLocalCandidates: [],
      pendingRemoteCandidates: [],
      pendingPings: new Map(),
      pingTimer: null,
      pathTimers: [],
    };
    this.peers.set(controllerSessionId, peer);
    channel.addEventListener("open", () => this.handleOpen(controllerSessionId, peer));
    channel.addEventListener("close", () => this.closePeer(controllerSessionId));
    channel.addEventListener("error", () => this.closePeer(controllerSessionId));
    channel.addEventListener("message", (event) => this.handleData(controllerSessionId, peer, event.data));
    connection.addEventListener("icecandidate", (event) => this.sendCandidate(controllerSessionId, peer, event.candidate));
    connection.addEventListener("connectionstatechange", () => this.handleConnectionState(controllerSessionId, peer));
    void this.createOffer(controllerSessionId, peer);
  }

  private async createOffer(controllerSessionId: string, peer: HostPeer): Promise<void> {
    try {
      const offer = await peer.connection.createOffer();
      await peer.connection.setLocalDescription(offer);
      const sdp = peer.connection.localDescription?.sdp;
      if (!sdp || !this.events.sendSignal({
        v: 1,
        type: "rtcOffer",
        controllerSessionId,
        rtcSessionId: peer.rtcSessionId,
        sdp,
      })) {
        this.closePeer(controllerSessionId);
        return;
      }
      peer.offerSent = true;
      for (const candidate of peer.pendingLocalCandidates.splice(0)) {
        this.events.sendSignal({
          v: 1,
          type: "rtcIceCandidate",
          controllerSessionId,
          rtcSessionId: peer.rtcSessionId,
          candidate,
        });
      }
    } catch {
      this.closePeer(controllerSessionId);
    }
  }

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
    this.events.sendSignal({
      v: 1,
      type: "rtcIceCandidate",
      controllerSessionId,
      rtcSessionId: peer.rtcSessionId,
      candidate: init,
    });
  }

  private handleOpen(controllerSessionId: string, peer: HostPeer): void {
    if (this.peers.get(controllerSessionId) !== peer) return;
    this.setConnected(controllerSessionId, peer, true);
    this.startPing(controllerSessionId, peer);
    this.schedulePathRefresh(controllerSessionId, peer);
  }

  /** RemoteEnvelopeとWebRTC RTT ping/pongを同じreliable channel上で処理する */
  private handleData(controllerSessionId: string, peer: HostPeer, data: unknown): void {
    if (this.peers.get(controllerSessionId) !== peer) return;
    const message = parseRtcDataMessage(data);
    if (!message) return;
    if (message.type === "remote") {
      this.events.onEnvelope(controllerSessionId, message.envelope);
      return;
    }
    if (message.type === "ping") {
      this.sendData(peer, { v: 1, type: "pong", nonce: message.nonce });
      return;
    }
    const sentAt = peer.pendingPings.get(message.nonce);
    if (sentAt === undefined) return;
    peer.pendingPings.delete(message.nonce);
    this.events.onLatency(controllerSessionId, Math.max(0, performance.now() - sentAt));
  }

  private startPing(controllerSessionId: string, peer: HostPeer): void {
    if (peer.pingTimer !== null) return;
    const ping = (): void => {
      if (this.peers.get(controllerSessionId) !== peer || peer.channel.readyState !== "open") return;
      const now = performance.now();
      for (const [nonce, sentAt] of peer.pendingPings) if (now - sentAt > RTC_PING_TIMEOUT_MS) peer.pendingPings.delete(nonce);
      const nonce = crypto.randomUUID();
      if (this.sendData(peer, { v: 1, type: "ping", nonce })) peer.pendingPings.set(nonce, now);
    };
    ping();
    peer.pingTimer = setInterval(ping, RTC_PING_INTERVAL_MS);
  }

  private sendData(peer: HostPeer, message: unknown): boolean {
    if (peer.channel.readyState !== "open") return false;
    try {
      peer.channel.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private schedulePathRefresh(controllerSessionId: string, peer: HostPeer): void {
    const refresh = async (): Promise<void> => {
      if (this.peers.get(controllerSessionId) !== peer) return;
      const path = await detectRemoteIcePath(peer.connection);
      if (this.peers.get(controllerSessionId) !== peer || path === peer.path) return;
      peer.path = path;
      if (peer.connected) this.events.onState(controllerSessionId, true, path);
    };
    void refresh();
    for (const delay of [250, 1_000, 3_000]) {
      peer.pathTimers.push(setTimeout(() => void refresh(), delay));
    }
  }

  private setConnected(controllerSessionId: string, peer: HostPeer, connected: boolean): void {
    if (this.peers.get(controllerSessionId) !== peer || peer.connected === connected) return;
    peer.connected = connected;
    this.events.onState(controllerSessionId, connected, peer.path);
  }

  private handleConnectionState(controllerSessionId: string, peer: HostPeer): void {
    const state = peer.connection.connectionState;
    if (state === "failed" || state === "closed") this.closePeer(controllerSessionId);
    // transient disconnected is left alive; AUTO can continue using WS until it recovers or fails.
  }

  private async flushRemoteCandidates(peer: HostPeer): Promise<void> {
    for (const candidate of peer.pendingRemoteCandidates.splice(0)) await peer.connection.addIceCandidate(candidate);
  }

  private closePeer(controllerSessionId: string): void {
    const peer = this.peers.get(controllerSessionId);
    if (!peer) return;
    this.peers.delete(controllerSessionId);
    if (peer.pingTimer !== null) clearInterval(peer.pingTimer);
    for (const timer of peer.pathTimers) clearTimeout(timer);
    if (peer.connected) this.events.onState(controllerSessionId, false, peer.path);
    try { peer.channel.close(); } catch { /* noop */ }
    try { peer.connection.close(); } catch { /* noop */ }
  }

  private closeAll(): void {
    for (const controllerSessionId of [...this.peers.keys()]) this.closePeer(controllerSessionId);
  }
}

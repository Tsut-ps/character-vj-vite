import type { RemoteIceCandidate, RemoteIceServers, RemotePath, RemoteWebRtcMode } from "./RemoteProtocol.ts";

const DIRECT_STUN: RTCIceServer = { urls: "stun:stun.cloudflare.com:3478" };

/** 選択modeに応じたICE設定を作る。AUTOはICE自身にDirect/TURNを選ばせる */
export function createRemoteRtcConfiguration(mode: RemoteWebRtcMode, iceServers: RemoteIceServers = []): RTCConfiguration {
  if (mode === "direct") return { iceServers: [DIRECT_STUN], iceTransportPolicy: "all" };
  const servers = iceServers.length > 0 ? iceServers : [DIRECT_STUN];
  return {
    iceServers: servers,
    iceTransportPolicy: mode === "turn" ? "relay" : "all",
  };
}

/** Native ICE candidateをstrict signaling schemaへ変換する */
export function serializeRemoteIceCandidate(candidate: RTCIceCandidate): RemoteIceCandidate {
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
    usernameFragment: candidate.usernameFragment,
  };
}

/** selected pairのcandidate typeから実経路を判定する */
export function classifyIceCandidateTypes(localType?: string, remoteType?: string): RemotePath {
  if (localType === "relay" || remoteType === "relay") return "TURN";
  const directTypes = new Set(["host", "srflx", "prflx"]);
  if ((localType && directTypes.has(localType)) || (remoteType && directTypes.has(remoteType))) return "DIRECT";
  return "UNKNOWN";
}

/** getStats()から実際にselectedされたICE candidate pairを探す */
export async function detectRemoteIcePath(connection: RTCPeerConnection): Promise<RemotePath> {
  try {
    const report = await connection.getStats();
    const stats = new Map<string, RTCStats>();
    report.forEach((entry) => stats.set(entry.id, entry));

    let pair: RTCStats | undefined;
    for (const entry of stats.values()) {
      const value = entry as RTCStats & Record<string, unknown>;
      if (entry.type === "transport" && typeof value.selectedCandidatePairId === "string") {
        pair = stats.get(value.selectedCandidatePairId);
        if (pair) break;
      }
    }
    if (!pair) {
      for (const entry of stats.values()) {
        const value = entry as RTCStats & Record<string, unknown>;
        if (entry.type === "candidate-pair" && (value.selected === true || (value.nominated === true && value.state === "succeeded"))) {
          pair = entry;
          break;
        }
      }
    }
    if (!pair) return "UNKNOWN";

    const pairValue = pair as RTCStats & Record<string, unknown>;
    const local = typeof pairValue.localCandidateId === "string" ? stats.get(pairValue.localCandidateId) : undefined;
    const remote = typeof pairValue.remoteCandidateId === "string" ? stats.get(pairValue.remoteCandidateId) : undefined;
    const localType = local ? String((local as RTCStats & Record<string, unknown>).candidateType ?? "") : undefined;
    const remoteType = remote ? String((remote as RTCStats & Record<string, unknown>).candidateType ?? "") : undefined;
    return classifyIceCandidateTypes(localType, remoteType);
  } catch {
    return "UNKNOWN";
  }
}

import type { RemoteIceCandidate } from "./RemoteProtocol.ts";

/** TURNを含まないDIRECT接続用STUN設定を返す */
export function createRemoteRtcConfiguration(): RTCConfiguration {
  return { iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] };
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

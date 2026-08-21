const TOKEN_BYTES = 32;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

/** Web CryptoでURL-safeな高エントロピーtokenを生成する */
export function createSecretToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** 生tokenを永続化しないためSHA-256 hexへ変換する */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 固定長hashをWeb Cryptoで定時間比較する */
export function constantTimeEqual(left: string, right: string): boolean {
  if (!SHA256_HEX_PATTERN.test(left) || !SHA256_HEX_PATTERN.test(right)) return false;
  const encoder = new TextEncoder();
  return crypto.subtle.timingSafeEqual(encoder.encode(left), encoder.encode(right));
}

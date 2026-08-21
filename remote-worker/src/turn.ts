import { z } from "zod";

const iceServerSchema = z.object({
  urls: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  username: z.string().optional(),
  credential: z.string().optional(),
}).strict();

const cloudflareTurnResponseSchema = z.object({
  iceServers: z.array(iceServerSchema).min(1).max(8),
}).strict();

/** Cloudflare長期TURN keyを短期ICE credentialsへ交換する */
type TurnEnv = Env & { TURN_KEY_ID?: string; TURN_KEY_API_TOKEN?: string };

export async function generateTurnIceServers(env: TurnEnv, ttlSeconds = 3600): Promise<Array<{ urls: string | string[]; username?: string; credential?: string }>> {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) throw new Error("TURN is not configured");
  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ttl: ttlSeconds }),
    },
  );
  if (!response.ok) throw new Error(`Cloudflare TURN credential request failed (${response.status})`);
  const parsed = cloudflareTurnResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("Cloudflare TURN returned an invalid response");
  return parsed.data.iceServers;
}

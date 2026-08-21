import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/** Wrangler bindingとSQLite-backed DOを使うWorker test poolを設定する */
export default defineConfig({
  plugins: [
    cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } }),
  ],
});

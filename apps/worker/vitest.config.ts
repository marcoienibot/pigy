import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Second line of defence behind test/setup.ts: what gets past the
        // guard there reaches this Worker, never the network. It has to be a
        // Worker: with a function here, Miniflare lets TCP connections pass
        // through to the real network.
        outboundService: "deny-outbound",
        workers: [
          {
            name: "deny-outbound",
            modules: true,
            scriptPath: "./test/deny-outbound.js",
          },
        ],
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});

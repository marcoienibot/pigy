import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Second line of defence behind test/setup.ts: a request that gets
        // past the guard there still cannot leave the local runtime.
        outboundService(request) {
          return new Response(`Blocked outbound request to ${request.url}`, {
            status: 502,
          });
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});

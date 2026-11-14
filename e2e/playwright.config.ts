import { defineConfig, devices } from "@playwright/test";

const port = 4173;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
  // Tests run against the production build, served by the Workers runtime
  // the same way it is deployed: static assets plus the Worker.
  webServer: {
    command: `pnpm build && pnpm preview --port ${port} --strictPort`,
    cwd: "..",
    url: `http://localhost:${port}/api/health`,
    // Always build: a server that is already running could serve a stale
    // build.
    reuseExistingServer: false,
  },
});

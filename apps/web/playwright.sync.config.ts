import { defineConfig } from "@playwright/test";

import rooms, { API_ENV } from "./playwright.rooms.config";

const REDIS_PORT = 6390;
import { CONTROL_PORT } from "./e2e-sync/ports";
const [fakeMal, api, web] = rooms.webServer as Extract<typeof rooms.webServer, unknown[]>;

// The sync soak test: several viewers in one real room, each on its own simulated network,
// measured against each other. It reports numbers rather than passing or failing on them.
export default defineConfig({
  ...rooms,
  testDir: "e2e-sync",
  globalSetup: "./e2e-sync/global-setup.ts",
  globalTeardown: "./e2e-sync/report.ts",
  // One room at a time, so viewers never compete with another test for the CPU.
  workers: 1,
  fullyParallel: false,
  timeout: 240_000,
  // The API runs under a supervisor that can kill and restart it, with a Redis of its own so
  // rooms survive that, as in production.
  webServer: [
    fakeMal,
    {
      command: `redis-server --port ${REDIS_PORT} --save "" --appendonly no`,
      port: REDIS_PORT,
      reuseExistingServer: !process.env.CI,
    },
    {
      ...api,
      command: "node e2e-sync/api-supervisor.mjs",
      cwd: undefined,
      env: { ...API_ENV, REDIS_URL: `redis://localhost:${REDIS_PORT}/0`, CONTROL_PORT: String(CONTROL_PORT) },
    },
    web,
  ],
});

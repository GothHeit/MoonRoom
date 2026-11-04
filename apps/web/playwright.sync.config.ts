import { defineConfig } from "@playwright/test";

import rooms from "./playwright.rooms.config";

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
});

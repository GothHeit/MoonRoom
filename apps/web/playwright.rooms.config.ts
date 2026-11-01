import { defineConfig } from "@playwright/test";

const PORT = 3101;
const API_PORT = 4020;
const MAL_PORT = 4021;

// Secrets here only protect a throwaway test database.
export const API_ENV = {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgresql+asyncpg://app:app@localhost:5432/app_test",
  JWT_SECRET: process.env.JWT_SECRET ?? "e2e-secret-that-is-at-least-32-characters-long",
  TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY ?? "Zm9yLWNpLW9ubHktZG8tbm90LXVzZS1pbi1wcm9kLTE=",
  MAL_CLIENT_ID: "e2e",
  MAL_API_BASE: `http://localhost:${MAL_PORT}/v2`,
  // A source has to be enabled for rooms to be created; the tests stub its video.
  VIDEO_SOURCES: "zoko",
  // Every test opens a room as the same host.
  MAX_ROOMS_PER_HOST: "50",
};

process.env.DATABASE_URL = API_ENV.DATABASE_URL;
process.env.JWT_SECRET = API_ENV.JWT_SECRET;
process.env.TOKEN_ENCRYPTION_KEY = API_ENV.TOKEN_ENCRYPTION_KEY;
process.env.MAL_CLIENT_ID = API_ENV.MAL_CLIENT_ID;

export default defineConfig({
  testDir: "e2e-rooms",
  globalSetup: "./e2e-rooms/global-setup.ts",
  timeout: 60_000,
  use: { baseURL: `http://localhost:${PORT}` },
  webServer: [
    {
      command: "node e2e-rooms/fake-mal.mjs",
      env: { FAKE_MAL_PORT: String(MAL_PORT) },
      url: `http://localhost:${MAL_PORT}/v2/anime/1`,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `uv run uvicorn app.main:app --port ${API_PORT}`,
      cwd: "../api",
      env: API_ENV,
      url: `http://localhost:${API_PORT}/health`,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `pnpm start --port ${PORT}`,
      // The web server reads the enabled sources too: only their names reach the browser.
      env: { API_URL: `http://localhost:${API_PORT}`, VIDEO_SOURCES: API_ENV.VIDEO_SOURCES },
      url: `http://localhost:${PORT}/en/login`,
      reuseExistingServer: !process.env.CI,
    },
  ],
});

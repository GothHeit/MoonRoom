import { fileURLToPath } from "node:url";

// The second plugin makes the CSS work on Chromium 94 (Samsung TVs); see the file for details.
const legacyBrowsers = fileURLToPath(
  new URL("./postcss-legacy-browsers.cjs", import.meta.url),
);

const config = { plugins: ["@tailwindcss/postcss", legacyBrowsers] };

export default config;

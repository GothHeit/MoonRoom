// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import postcss from "postcss";

const require = createRequire(import.meta.url);
const legacy = require("../postcss-legacy-browsers.cjs");

const layered = (css: string) => run(`@layer utilities{${css}}`);
const run = async (css: string) =>
  (await postcss([legacy()]).process(css, { from: undefined })).css;

describe("legacy browser CSS (Chromium 94 on Samsung TVs)", () => {
  it("unwraps @layer in place and keeps the order", async () => {
    const out = await run(
      "@layer a, b;\n@layer a{.x{color:red}}\n@layer b{.y{color:blue}}\n.z{color:green}",
    );
    expect(out).not.toContain("@layer");
    expect(out.indexOf(".x")).toBeLessThan(out.indexOf(".y"));
    expect(out.indexOf(".y")).toBeLessThan(out.indexOf(".z"));
  });

  it("keeps unlayered rules winning over layered utilities", async () => {
    const out = await run(
      "@layer utilities{.text-sm{font-size:14px}}select,textarea{font-size:16px}.no-scrollbar::-webkit-scrollbar{display:none}@keyframes k{from{opacity:0}}",
    );
    expect(out).toContain(".text-sm{");
    expect(out).toMatch(/select:not\(#\\#\)/);
    expect(out).toContain(".no-scrollbar:not(#\\#)::-webkit-scrollbar");
    expect(out).not.toMatch(/\.text-sm:not/);
    expect(out).not.toMatch(/(from|to):not/);
  });

  it("falls back to transform only where translate/scale are unsupported", async () => {
    const out = await layered(
      ".c{translate:var(--tw-translate-x) var(--tw-translate-y)}",
    );
    expect(out).toContain("translate:var(--tw-translate-x)");
    expect(out).toMatch(
      /@supports not \(translate: 0\)\s*{\s*\.c\s*{\s*transform:/,
    );
  });

  it("carries literal scale values into the fallback and turns percent scales into numbers", async () => {
    const out = await layered(
      ".a{scale:1.06}.b{--tw-scale-x:125%;scale:var(--tw-scale-x) var(--tw-scale-y)}",
    );
    expect(out).toMatch(
      /\.a\s*{\s*--tw-scale-x:\s*1\.06;\s*--tw-scale-y:\s*1\.06;\s*transform:/,
    );
    expect(out).toContain("--tw-scale-x:1.25");
  });

  it("keeps media queries around a fallback", async () => {
    const out = await layered("@media (min-width:600px){.c{scale:1.1}}");
    expect(out).toMatch(
      /@media \(min-width:600px\)\s*{\s*@supports not \(translate: 0\)/,
    );
  });

  it("adds a vh copy of dvh/svh/lvh values under @supports", async () => {
    const out = await layered(".h{min-height:calc(100dvh - 2rem);margin:0}");
    expect(out).toContain("min-height:calc(100dvh - 2rem)");
    expect(out).toMatch(
      /@supports not \(height: 1dvh\)\s*{\s*\.h\s*{\s*min-height:calc\(100vh - 2rem\)/,
    );
  });
});

describe("built stylesheet", () => {
  it("has no @layer and keeps fallbacks for what Chromium 94 lacks", async () => {
    const tailwind = require("@tailwindcss/postcss");
    const file = new URL("./app/globals.css", import.meta.url).pathname;
    const base = new URL("..", import.meta.url).pathname;
    const out = (
      await postcss([tailwind({ base }), legacy()]).process(
        readFileSync(file, "utf8"),
        { from: file },
      )
    ).css;
    expect(out).not.toMatch(/@layer\b/);
    expect(out).toMatch(/@supports not \(translate: 0\)/);
    expect(out).toMatch(/@supports not \(height: 1dvh\)/);
  });
});

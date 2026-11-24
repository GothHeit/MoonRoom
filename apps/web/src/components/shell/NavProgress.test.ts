import { describe, expect, it } from "vitest";

import { destinationOf } from "./NavProgress";

const HERE = "https://moonroom.test/pt/browse?genre=1";

function click(href: string, init: MouseEventInit = {}, attrs: Record<string, string> = {}) {
  const link = document.createElement("a");
  link.setAttribute("href", href);
  for (const [name, value] of Object.entries(attrs)) link.setAttribute(name, value);
  const inner = document.createElement("span");
  link.append(inner);
  document.body.append(link);
  let seen: string | null = null;
  link.addEventListener("click", (event) => {
    event.preventDefault();
    seen = destinationOf(event, HERE);
  });
  inner.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  link.remove();
  return seen;
}

describe("destinationOf", () => {
  it("finds the page a link inside the site leads to", () => {
    expect(click("/pt/anime/5")).toBe("/pt/anime/5");
    expect(click("/pt/browse?genre=2")).toBe("/pt/browse?genre=2");
  });

  it("ignores links that load no new page here", () => {
    expect(click("/pt/browse?genre=1")).toBeNull();
    expect(click("#security")).toBeNull();
    expect(click("https://myanimelist.net/anime/5")).toBeNull();
    expect(click("/pt/anime/5", {}, { target: "_blank" })).toBeNull();
    expect(click("/file.png", {}, { download: "" })).toBeNull();
  });

  it("ignores clicks that open a new tab or window", () => {
    expect(click("/pt/anime/5", { ctrlKey: true })).toBeNull();
    expect(click("/pt/anime/5", { metaKey: true })).toBeNull();
    expect(click("/pt/anime/5", { shiftKey: true })).toBeNull();
    expect(click("/pt/anime/5", { button: 1 })).toBeNull();
  });
});

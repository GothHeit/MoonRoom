import { describe, expect, it } from "vitest";

import { drain } from "./drain";

describe("drain", () => {
  it("reads the body to the end, so the request finishes", async () => {
    const response = new Response("ok");
    expect(await drain(response)).toBe(response);
    expect(response.bodyUsed).toBe(true);
  });

  it("is harmless on a body already read or missing", async () => {
    const used = new Response("ok");
    await used.text();
    await expect(drain(used)).resolves.toBe(used);
    await expect(drain({ ok: true } as Response)).resolves.toBeTruthy();
  });
});

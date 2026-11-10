import { expect, test } from "@playwright/test";

import { signIn } from "./helpers";

// Tablet portrait up to a small laptop window: the desktop bar has to fit without the phone tab bar.
for (const width of [768, 820, 1024, 1280]) {
  test(`the top bar fits at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, "pt");

    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(0);

    const bar = page.getByRole("banner");
    const list = bar.getByRole("link", { name: "Minha lista" });
    const home = bar.getByRole("link", { name: "Início" });
    expect((await list.boundingBox())!.height).toBe((await home.boundingBox())!.height);

    const account = bar.getByRole("button", { name: "Menu da conta" });
    const box = (await account.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await account.click();
    await expect(page.getByRole("menuitem", { name: "Sair" })).toBeInViewport({ ratio: 1 });
  });
}

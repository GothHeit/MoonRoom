import { expect, test } from "@playwright/test";

import { signIn } from "./helpers";

const API = "http://localhost:4010";

test.beforeEach(async ({ request }) => {
  await request.get(`${API}/comments/__reset`);
});

test("shows friends' comments at the bottom with a link from the header", async ({ page }) => {
  await signIn(page);
  await page.goto("/en/anime/1");
  const link = page.getByRole("link", { name: "4 comments" });
  await expect(link).toHaveAttribute("href", "#comments");

  const section = page.getByRole("region", { name: "Comments" });
  await expect(section.getByText("Only you and your friends can see these.")).toBeVisible();
  // Where friends are in the show, inside the comments section only.
  await expect(section.getByText("junior is on ep 2")).toBeVisible();
  await expect(section.getByText("pondofe finished it")).toBeVisible();
  await expect(section.getByText("+2 more")).toBeVisible();
  await expect(page.getByText("junior is on ep 2")).toHaveCount(1);

  // The newest three, a hidden spoiler, then the rest on demand.
  await expect(section.getByText(/Episode 10 alone/)).toBeVisible();
  await expect(section.getByText("The ending of episode 3 broke me.")).toHaveCount(0);
  await section.getByRole("button", { name: "Spoiler. Tap to show" }).click();
  await expect(section.getByText("The ending of episode 3 broke me.")).toBeVisible();
  await section.getByRole("button", { name: "Show all 4 comments" }).click();
  await expect(section.getByText(/Himmel being right/)).toBeVisible();
  await expect(section.getByText("edited")).toBeVisible();
});

test("posts, edits and deletes your own comment", async ({ page }) => {
  await signIn(page);
  await page.goto("/en/anime/3");
  const section = page.getByRole("region", { name: "Comments" });
  await expect(section.getByRole("heading", { name: "No comments yet" })).toBeVisible();
  await expect(page.getByRole("link", { name: /comments?$/ })).toHaveCount(0);

  const post = section.getByRole("button", { name: "Post" });
  await expect(post).toBeDisabled();
  await section.getByLabel("Write a comment").fill("Loved the first arc.");
  await post.click();
  await expect(section.getByText("Loved the first arc.")).toBeVisible();
  await expect(page.getByRole("link", { name: "1 comment" })).toBeVisible();

  await section.getByRole("button", { name: "Comment options" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const editor = section.getByLabel("Edit your comment");
  await editor.fill("Loved the first arc. The second too.");
  await section.getByRole("button", { name: "Save" }).click();
  await expect(section.getByText("Loved the first arc. The second too.")).toBeVisible();
  await expect(section.getByText("edited")).toBeVisible();

  await section.getByRole("button", { name: "Comment options" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog", { name: "Delete this comment?" }).getByRole("button", { name: "Delete" }).click();
  await expect(section.getByRole("heading", { name: "No comments yet" })).toBeVisible();
  await expect(page.getByRole("link", { name: /comments?$/ })).toHaveCount(0);
});

test("comments on manga pages, in Portuguese", async ({ page }) => {
  await signIn(page, "pt");
  await page.goto("/pt/manga/1");
  await expect(page.getByRole("link", { name: "1 comentário" })).toBeVisible();
  const section = page.getByRole("region", { name: "Comentários" });
  await expect(section.getByText("junior está no cap. 112")).toBeVisible();
  await expect(section.getByText(/later volumes/)).toBeVisible();
});

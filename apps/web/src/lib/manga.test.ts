import { describe, expect, it } from "vitest";

import { chapterPageOf, chapterRangeLabel, defaultReading, nextChapter, progressKey, readFraction, readHref, type Chapter } from "./manga";

const ch = (id: string, number: string): Chapter => ({ id, number, lang: "en" });
const done = { manga_id: 1, chapter: "", page: 9, pages: 10, completed: true, updated_at: "" };

describe("manga helpers", () => {
  it("opens webtoons as a strip and manga as pages, right to left", () => {
    expect(defaultReading("manhwa")).toEqual({ mode: "strip", direction: "ltr" });
    expect(defaultReading("manga")).toEqual({ mode: "page", direction: "rtl" });
    expect(defaultReading(undefined).mode).toBe("page");
  });

  it("files progress by chapter number, or id when there is none", () => {
    expect(progressKey(ch("abc", "12.5"))).toBe("12.5");
    expect(progressKey(ch("0123456789abcdef0123", ""))).toBe("0123456789abcdef");
  });

  it("links the reader with the language", () => {
    expect(readHref("mangadex", 5, "c 1", "pt-br")).toBe("/read/mangadex/5/c%201?lang=pt-br");
    expect(readHref("mangadex", 5, "c1")).toBe("/read/mangadex/5/c1");
  });

  it("picks the chapter being read, else the first after the last finished", () => {
    const chapters = [ch("a", "1"), ch("b", "2"), ch("c", "3")];
    expect(nextChapter(chapters, {})).toEqual({ chapter: chapters[0], resume: false });
    expect(nextChapter(chapters, { "1": done })).toEqual({ chapter: chapters[1], resume: false });
    expect(nextChapter(chapters, { "1": done, "3": { ...done, completed: false, page: 2 } })).toEqual({ chapter: chapters[2], resume: true });
    expect(nextChapter(chapters, { "3": done })).toBeNull();
    expect(nextChapter([], {})).toBeNull();
  });

  it("measures how much of a chapter was read", () => {
    expect(readFraction(done)).toBe(1);
    expect(readFraction({ page: 3, pages: 7, completed: false })).toBe(0.5);
    expect(readFraction({ page: 0, pages: 1, completed: false })).toBe(0.02);
  });

  it("picks the range with the next unread chapter", () => {
    const long = Array.from({ length: 250 }, (_, i) => ch(`c${i + 1}`, String(i + 1)));
    const upTo = (n: number) => Object.fromEntries(long.slice(0, n).map((c) => [c.number, done]));
    expect(chapterPageOf(long, {})).toBe(0);
    expect(chapterPageOf(long, upTo(99))).toBe(0);
    expect(chapterPageOf(long, upTo(100))).toBe(1);
    expect(chapterPageOf(long, upTo(250))).toBe(2);
    expect(chapterPageOf([], {})).toBe(0);
    expect(chapterRangeLabel(long, 2)).toBe("201–250");
  });
});

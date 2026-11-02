import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";

import { enabledSources, mergeMessages, pruneSources } from "./messages";
import { routing } from "./routing";

// Every messages/<locale>/*.json file is merged, so each area owns its own file.
async function loadMessages(locale: string) {
  const dir = join(process.cwd(), "messages", locale);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  const parts = await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(dir, f), "utf8"))));
  // Names of unlicensed sources only ship for the sources this server runs (plus the local library).
  return pruneSources(mergeMessages(parts), ["auto", "local", ...enabledSources(process.env.VIDEO_SOURCES)]);
}

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
  // A fixed zone and a shared "now" keep server and browser renderings of dates identical.
  return { locale, messages: await loadMessages(locale), timeZone: "UTC", now: new Date() };
});

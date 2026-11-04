import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { REPORT_DIR, type Result } from "./harness";

const ms = (seconds: number | null) => (seconds === null || Number.isNaN(seconds) ? "-" : `${Math.round(seconds * 1000)}`);
const pct = (share: number) => `${Math.round(share * 100)}%`;

/** Gathers every scenario's numbers into report.md and report.json. */
export default function report() {
  if (!existsSync(REPORT_DIR)) return;
  const results: Result[] = readdirSync(REPORT_DIR)
    .filter((f) => f.endsWith(".json") && f !== "report.json")
    .map((f) => JSON.parse(readFileSync(join(REPORT_DIR, f), "utf8")));
  if (results.length === 0) return;
  const lines = [
    "# Room sync report",
    "",
    "Spread = distance between the furthest-ahead and furthest-behind viewer, in ms, leaving out the 3 s after each action.",
    "",
    "| Scenario | p50 | p95 | max | in sync (<250 ms) | out of step | seeks | stalls |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...results.map((r) => {
      const seeks = r.viewers.reduce((a, v) => a + v.seeks, 0);
      const stalls = r.viewers.reduce((a, v) => a + v.stalls, 0);
      return `| ${r.scenario} | ${ms(r.spread.p50)} | ${ms(r.spread.p95)} | ${ms(r.spread.max)} | ${pct(r.spread.inSyncShare)} | ${pct(r.disagreeShare)} | ${seeks} | ${stalls} |`;
    }),
    "",
    "## Per viewer (mean offset from the middle viewer, ms; negative = behind)",
    "",
    ...results.flatMap((r) => [
      `- **${r.scenario}**: ` +
        r.viewers.map((v) => `${v.name} (${v.net.latency ?? 0} ms) ${ms(v.meanOffset)}`).join(", "),
    ]),
    "",
    "## Time until everyone is within 500 ms again after each action (s)",
    "",
    ...results
      .filter((r) => r.recover.length > 0)
      .map((r) => `- **${r.scenario}**: ` + r.recover.map((x) => `${x.label}: ${x.seconds === null ? "never" : x.seconds.toFixed(1)}`).join("; ")),
    "",
  ];
  writeFileSync(join(REPORT_DIR, "report.md"), lines.join("\n"));
  writeFileSync(join(REPORT_DIR, "report.json"), JSON.stringify(results, null, 2));
  console.log(lines.join("\n"));
}

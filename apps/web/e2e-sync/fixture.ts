import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const FIXTURE_DIR = join(__dirname, ".cache", "hls");
const PLAYLIST = join(FIXTURE_DIR, "index.m3u8");
const SECONDS = 600;

/**
 * A 10 minute HLS test video with the time and frame number burned in, cut into 4 s segments.
 * Real segments make buffering real, and the burned-in time makes a screenshot show the drift.
 * Generated once (about 20 s) and kept out of git. Segments are named .seg, not .ts, so the
 * TypeScript tools never mistake them for code.
 */
export function ensureFixture() {
  if (existsSync(PLAYLIST)) return;
  mkdirSync(FIXTURE_DIR, { recursive: true });
  execFileSync(
    "ffmpeg",
    [
      "-v", "error",
      "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=25:duration=${SECONDS}`,
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${SECONDS}`,
      "-vf", "drawtext=text='%{pts\\:hms} f%{n}':fontsize=48:fontcolor=white:box=1:boxcolor=black:x=20:y=20",
      "-c:v", "libx264", "-preset", "ultrafast", "-g", "50", "-keyint_min", "50", "-sc_threshold", "0", "-b:v", "400k",
      "-c:a", "aac", "-b:a", "64k",
      "-f", "hls", "-hls_time", "4", "-hls_playlist_type", "vod",
      "-hls_segment_filename", join(FIXTURE_DIR, "seg%03d.seg"),
      PLAYLIST,
    ],
    { stdio: "inherit" },
  );
}

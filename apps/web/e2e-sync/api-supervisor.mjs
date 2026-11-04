// Runs the API for the sync tests and can kill it the way a deploy does (no goodbye), then
// start it again: POST /restart on the control port. Everything else passes through.
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const API_PORT = process.env.API_PORT ?? "4020";
const CONTROL_PORT = Number(process.env.CONTROL_PORT ?? 4022);
let api;

function start() {
  api = spawn("uv", ["run", "uvicorn", "app.main:app", "--port", API_PORT], { cwd: "../api", stdio: "inherit" });
}

async function waitUntilUp() {
  for (let i = 0; i < 300; i++) {
    try {
      const response = await fetch(`http://localhost:${API_PORT}/health`);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

start();
createServer(async (req, res) => {
  if (req.method === "POST" && req.url?.startsWith("/restart")) {
    const down = Number(new URL(req.url, "http://x").searchParams.get("down") ?? 0);
    const old = api;
    await new Promise((resolve) => {
      old.once("exit", resolve);
      old.kill("SIGKILL");
    });
    await new Promise((resolve) => setTimeout(resolve, down));
    start();
    await waitUntilUp();
    res.end("restarted");
    return;
  }
  res.statusCode = 404;
  res.end();
}).listen(CONTROL_PORT);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    api?.kill("SIGKILL");
    process.exit(0);
  });
}

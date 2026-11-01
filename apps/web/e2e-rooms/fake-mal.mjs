// Stand-in for the public MyAnimeList API, so the room tests don't depend on the internet.
import { createServer } from "node:http";

const PORT = Number(process.env.FAKE_MAL_PORT ?? 4021);

createServer((req, res) => {
  const match = /^\/v2\/anime\/(\d+)/.exec(req.url ?? "");
  res.setHeader("content-type", "application/json");
  if (!match) {
    res.statusCode = 404;
    res.end("{}");
    return;
  }
  res.end(JSON.stringify({ id: Number(match[1]), title: "Moon Test", nsfw: "white", genres: [] }));
}).listen(PORT);

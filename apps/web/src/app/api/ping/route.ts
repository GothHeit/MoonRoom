// Answers "is the site up?" for the TV: the wrapper and the open page ask this (Caddy answers
// it first in production, with the headers a cross-origin check needs).
export const dynamic = "force-dynamic";

export function GET() {
  return new Response("ok", { headers: { "Cache-Control": "no-store" } });
}

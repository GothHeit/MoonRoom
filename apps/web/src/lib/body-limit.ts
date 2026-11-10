// The largest request body the proxy accepts: the avatar upload (2 MB) plus multipart overhead.
const MAX_BODY_BYTES = 3 * 1024 * 1024;

/** Reads a request body, giving up (null) as soon as it passes the limit instead of buffering it all. */
export async function readLimitedBody(request: Request, limit = MAX_BODY_BYTES): Promise<ArrayBuffer | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return new ArrayBuffer(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

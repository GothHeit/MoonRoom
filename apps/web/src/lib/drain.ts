/**
 * Reads a response to the end and throws it away. A response whose body is never read keeps its
 * connection (or HTTP/2 stream) open until the garbage collector finds it, which on a TV, with
 * its tiny heap, can be never: a check every few seconds then piles up hundreds of open requests
 * until the TV has none left for video. Every fetch whose answer we ignore goes through here.
 */
export async function drain(response: Response): Promise<Response> {
  try {
    await response.arrayBuffer();
  } catch {
    // Already read, or the connection dropped: either way nothing is left open.
  }
  return response;
}

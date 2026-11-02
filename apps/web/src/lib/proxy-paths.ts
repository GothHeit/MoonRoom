// The API paths the browser may reach through /api/proxy. Everything else (above all /auth/*,
// which the web server calls itself so it can manage the cookies) is refused.
const PREFIXES = ["anime", "manga", "home", "invites", "watch", "me", "friends", "notifications"];

// Dot segments and anything that could be read as a path separator are never legitimate.
const unsafeSegment = (segment: string) => segment.startsWith("..") || segment === "." || /[/\\]/.test(segment);

export function isProxyPathAllowed(path: string[]): boolean {
  const [first, second] = path;
  if (first === "mal") return path.length === 2 && second === "link";
  if (first === "users") {
    const clean = !path.some(unsafeSegment);
    // /users/lookup, /users/{id}/avatar and /users/{id}/profile
    return clean && ((path.length === 2 && second === "lookup") || (path.length === 3 && (path[2] === "avatar" || path[2] === "profile")));
  }
  return PREFIXES.includes(first) && !path.some(unsafeSegment);
}

/** Error codes that mean "the access token is bad", the only 401s a refresh can fix. */
const AUTH_CODES = ["not_authenticated", "invalid_token"];

export async function isAuthFailure(response: Response): Promise<boolean> {
  if (response.status !== 401) return false;
  try {
    const body = (await response.clone().json()) as { error?: { code?: string } };
    return AUTH_CODES.includes(body.error?.code ?? "");
  } catch {
    return false;
  }
}

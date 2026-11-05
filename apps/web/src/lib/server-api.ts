import { createApiClient } from "@app/api-client";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { API_URL } from "./config";
import { ACCESS_COOKIE } from "./cookies";
import { toApiError } from "./errors";

/** API client for server components, authenticated with the session cookie. */
export async function serverApi() {
  const access = (await cookies()).get(ACCESS_COOKIE)?.value ?? null;
  return createApiClient(API_URL, () => access);
}

/** A route that drops the cookies before showing /login, so the middleware cannot send the user back. */
export function expiredSessionPath(locale: string, to?: "tv") {
  return `/api/auth/expired?locale=${encodeURIComponent(locale)}${to ? `&to=${to}` : ""}`;
}

type Result<T> = { data?: T; error?: unknown; response: Response };

/**
 * Unwraps an API result. 404 shows the not-found page, 401 clears the stale cookies and sends the user to sign in and any
 * other failure throws an ApiError for the nearest error boundary.
 */
export async function unwrap<T>(result: Promise<Result<T>>, locale: string, to?: "tv"): Promise<T> {
  const { data, error, response } = await result;
  if (data !== undefined) return data;
  if (response.status === 404) notFound();
  if (response.status === 401) redirect(expiredSessionPath(locale, to));
  throw toApiError(response.status, error);
}

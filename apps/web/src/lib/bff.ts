"use client";

import { errorCode } from "@app/api-client";

export type AuthStep =
  | { kind: "signed-in" }
  | { kind: "needs-code"; mfaToken: string }
  | { kind: "error"; code: string };

/** POSTs to a web server auth route. Tells whether the user is in, needs a second-step code, or why not. */
export async function postAuthStep(path: string, body: unknown): Promise<AuthStep> {
  try {
    const res = await fetch(`/api/auth/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 204) return { kind: "signed-in" };
    const data = await res.json().catch(() => undefined);
    if (res.ok) {
      const token = (data as { mfa_token?: unknown } | undefined)?.mfa_token;
      return typeof token === "string" ? { kind: "needs-code", mfaToken: token } : { kind: "signed-in" };
    }
    return { kind: "error", code: errorCode(data) };
  } catch {
    return { kind: "error", code: "network" };
  }
}

/** POSTs to a web server auth route. Returns the API error code on failure, or null on success. */
export async function postAuth(path: string, body: unknown): Promise<string | null> {
  const step = await postAuthStep(path, body);
  return step.kind === "error" ? step.code : null;
}

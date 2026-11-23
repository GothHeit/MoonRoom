"use client";

import { errorCode } from "@app/api-client";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Link } from "@/i18n/navigation";

type State =
  | { kind: "checking" }
  | { kind: "dead" }
  | { kind: "ready"; token: string; username: string }
  | { kind: "done" };

async function post(path: string, body: unknown): Promise<{ ok: boolean; data?: unknown; code: string }> {
  try {
    const res = await fetch(`/api/auth/password-reset${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { ok: res.ok, data, code: res.ok ? "" : errorCode(data) };
  } catch {
    return { ok: false, code: "network" };
  }
}

/** Sets a new password with the one-time link an admin sent. The token rides in the #fragment. */
export function ResetPasswordForm() {
  const t = useTranslations("resetPassword");
  const tErr = useTranslations("errors");
  const [state, setState] = useState<State>({ kind: "checking" });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      const token = decodeURIComponent(window.location.hash.slice(1));
      const res = token ? await post("/check", { token }) : null;
      if (cancelled) return;
      const username = (res?.data as { username?: string } | undefined)?.username;
      setState(res?.ok && username ? { kind: "ready", token, username } : { kind: "dead" });
    }
    void check();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "checking") return <p className="text-muted">{t("loading")}</p>;

  if (state.kind === "dead") {
    return (
      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-bold">{t("deadTitle")}</h2>
        <p className="text-muted">{t("deadBody")}</p>
      </div>
    );
  }

  if (state.kind === "done") {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-bold">{t("doneTitle")}</h2>
        <p className="text-muted">{t("doneBody")}</p>
        <Link href="/login" className="press inline-flex min-h-11 items-center justify-center rounded-full bg-accent px-5 py-2 text-sm font-bold text-on-accent">
          {t("signIn")}
        </Link>
      </div>
    );
  }

  const { token, username } = state;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const password = String(form.get("password") ?? "");
    if (password !== form.get("again")) {
      setError(t("mismatch"));
      return;
    }
    setPending(true);
    setError(null);
    const res = await post("", { token, new_password: password });
    if (res.ok) {
      // Nothing left to hide: drop the spent token from the address bar and history.
      window.history.replaceState(null, "", window.location.pathname);
      setState({ kind: "done" });
      return;
    }
    if (res.code === "invalid_reset_link") {
      setState({ kind: "dead" });
      return;
    }
    setError(tErr.has(res.code) ? tErr(res.code) : tErr("unknown"));
    setPending(false);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4 short:gap-2">
      <p className="text-sm text-muted">{t("intro", { username })}</p>
      <input type="hidden" name="username" value={username} autoComplete="username" readOnly />
      <Field
        label={t("password")}
        name="password"
        type="password"
        required
        minLength={8}
        maxLength={128}
        autoComplete="new-password"
        autoFocus
        hint={t("passwordHint")}
      />
      <Field label={t("again")} name="again" type="password" required minLength={8} maxLength={128} autoComplete="new-password" />
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? t("saving") : t("submit")}
      </Button>
    </form>
  );
}

"use client";

import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";
import { useRouter } from "@/i18n/navigation";
import { postAuthStep } from "@/lib/bff";
import { safeNext } from "@/lib/redirect";

import { Button } from "@/components/ui/Button";

type Props = {
  endpoint: "login" | "login/2fa" | "register";
  submitLabel: string;
  /** Extra values merged into the request body (such as the locale). */
  extra?: Record<string, string>;
  /** Called with the challenge token when the account asks for a second-step code. */
  onChallenge?: (mfaToken: string) => void;
  children: ReactNode;
};

/** Posts the form to the web server's auth route, then goes where the user was headed. */
export function AuthForm({ endpoint, submitLabel, extra, onChallenge, children }: Props) {
  const tErr = useTranslations("errors");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = { ...Object.fromEntries(new FormData(e.currentTarget)), ...extra };
    setPending(true);
    setError(null);
    const step = await postAuthStep(endpoint, body);
    if (step.kind === "error") {
      setError(tErr.has(step.code) ? tErr(step.code) : tErr("unknown"));
      setPending(false);
      return;
    }
    if (step.kind === "needs-code" && onChallenge) {
      onChallenge(step.mfaToken);
      return;
    }
    router.replace(safeNext(new URLSearchParams(window.location.search).get("next")));
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4 short:gap-2">
      {children}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {submitLabel}
      </Button>
    </form>
  );
}

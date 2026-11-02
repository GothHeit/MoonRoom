"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { Field } from "@/components/ui/Field";

import { AuthForm } from "./AuthForm";

export function LoginForm() {
  const t = useTranslations("login");
  const [mfaToken, setMfaToken] = useState<string | null>(null);

  if (mfaToken) return <SecondStep mfaToken={mfaToken} />;
  return (
    <AuthForm endpoint="login" submitLabel={t("submit")} onChallenge={setMfaToken}>
      <Field label={t("username")} name="username" required autoComplete="username" />
      <Field label={t("password")} name="password" type="password" required autoComplete="current-password" />
    </AuthForm>
  );
}

/** Asks for an authenticator code, or a backup code, after the password was right. */
function SecondStep({ mfaToken }: { mfaToken: string }) {
  const t = useTranslations("login.twoFactor");
  return (
    <AuthForm endpoint="login/2fa" submitLabel={t("submit")} extra={{ mfa_token: mfaToken }}>
      <p className="text-sm text-muted">{t("intro")}</p>
      <Field
        label={t("code")}
        name="code"
        required
        autoFocus
        autoComplete="one-time-code"
        inputMode="text"
        autoCapitalize="none"
        spellCheck={false}
        hint={t("hint")}
      />
      <label className="flex min-h-11 items-center gap-3 text-sm">
        <input type="checkbox" name="trust_device" className="h-5 w-5 accent-[var(--color-accent)]" />
        {t("trust")}
      </label>
    </AuthForm>
  );
}

"use client";

import { errorCode } from "@app/api-client";
import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import { api } from "@/lib/api";

const MIN_PASSWORD = 8;

export function PasswordForm() {
  const t = useTranslations("account.password");
  const tErr = useTranslations("errors");
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next.length < MIN_PASSWORD) return setProblem(t("tooShort", { count: MIN_PASSWORD }));
    if (next !== again) return setProblem(t("mismatch"));
    setProblem(null);
    setBusy(true);
    try {
      const { response, error } = await api.POST("/me/password", {
        body: { current_password: current, new_password: next },
      });
      if (!response.ok) {
        const code = errorCode(error);
        setProblem(tErr.has(code) ? tErr(code) : tErr("unknown"));
        return;
      }
      setCurrent("");
      setNext("");
      setAgain("");
      toast(t("changed"), "success");
    } catch {
      setProblem(tErr("network"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex max-w-sm flex-col gap-4">
      <Field
        label={t("current")}
        type="password"
        autoComplete="current-password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        required
      />
      <Field
        label={t("new")}
        type="password"
        autoComplete="new-password"
        hint={t("hint", { count: MIN_PASSWORD })}
        value={next}
        onChange={(e) => setNext(e.target.value)}
        required
      />
      <Field
        label={t("again")}
        type="password"
        autoComplete="new-password"
        value={again}
        onChange={(e) => setAgain(e.target.value)}
        required
      />
      {problem && (
        <p role="alert" className="text-sm text-danger">
          {problem}
        </p>
      )}
      <div>
        <Button type="submit" disabled={busy || !current || !next || !again}>
          {busy ? t("saving") : t("submit")}
        </Button>
      </div>
      <p className="text-xs text-muted">{t("othersNote")}</p>
    </form>
  );
}

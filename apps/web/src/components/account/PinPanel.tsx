"use client";

import { errorCode } from "@app/api-client";
import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import { api } from "@/lib/api";

type Step = "idle" | "set" | "remove";

/** The PIN a TV asks for before it shows the account. Set and removed here, never on the TV. */
export function PinPanel({ enabled }: { enabled: boolean }) {
  const t = useTranslations("account.pin");
  const tErr = useTranslations("errors");
  const toast = useToast();
  const [on, setOn] = useState(enabled);
  const [step, setStep] = useState<Step>("idle");
  const [pin, setPin] = useState("");
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setStep("idle");
    setPin("");
    setPassword("");
    setProblem(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (step === "set" && !/^\d{4,6}$/.test(pin)) return setProblem(t("invalid"));
    setProblem(null);
    setBusy(true);
    try {
      const { response, error } =
        step === "set"
          ? await api.PUT("/auth/pin", { body: { pin, password } })
          : await api.POST("/auth/pin/remove", { body: { password } });
      if (!response.ok) {
        const code = errorCode(error);
        setProblem(tErr.has(code) ? tErr(code) : tErr("unknown"));
        return;
      }
      setOn(step === "set");
      toast(step === "set" ? t("saved") : t("removed"), "success");
      reset();
    } catch {
      setProblem(tErr("network"));
    } finally {
      setBusy(false);
    }
  }

  if (step === "idle") {
    return (
      <div className="flex max-w-xl flex-col gap-4">
        <p className="text-sm text-soft">{t("intro")}</p>
        <p className="text-sm font-bold">{on ? t("on") : t("off")}</p>
        <div className="flex flex-wrap gap-3">
          <Button type="button" onClick={() => setStep("set")}>
            {on ? t("change") : t("set")}
          </Button>
          {on && (
            <Button type="button" variant="secondary" onClick={() => setStep("remove")}>
              {t("remove")}
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex max-w-sm flex-col gap-4">
      {step === "set" && (
        <Field
          label={t("pinLabel")}
          hint={t("pinHint")}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={6}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
          required
        />
      )}
      <Field label={t("password")} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      {problem && (
        <p role="alert" className="text-sm text-danger">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={busy || !password || (step === "set" && !pin)}>
          {busy ? t("saving") : step === "set" ? t("save") : t("confirmRemove")}
        </Button>
        <Button type="button" variant="secondary" onClick={reset}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}

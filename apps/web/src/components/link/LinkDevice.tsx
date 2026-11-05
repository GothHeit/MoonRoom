"use client";

import { errorCode } from "@app/api-client";
import { useFormatter, useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { describeAgent } from "@/components/account/describeAgent";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { api } from "@/lib/api";

type Device = { user_agent: string | null; ip: string | null; created_at: string };
type Step = { kind: "enter" } | { kind: "confirm"; code: string; device: Device } | { kind: "done" } | { kind: "declined" };

/** "BCDFGHJK" or "bcdf ghjk" -> "BCDF-GHJK", the way the TV shows it. */
export function formatCode(raw: string) {
  const letters = raw.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 8);
  return letters.length > 4 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters;
}

/** The TV's browser in words: "Samsung TV", "LG TV", else "Chrome on Linux". */
function deviceName(agent: string | null, t: (key: string) => string) {
  if (agent && /Tizen|SMART-TV|SamsungBrowser.*TV/i.test(agent)) return t("samsung");
  if (agent && /Web0S|webOS|NetCast/i.test(agent)) return t("lg");
  const { browser, system } = describeAgent(agent);
  if (browser && system) return `${browser} · ${system}`;
  return browser ?? system ?? t("unknownDevice");
}

/**
 * The phone's side of signing in a TV: type (or scan) the code the TV shows, see which device asked,
 * and approve or decline it. Approving hands that TV a session of this account.
 */
export function LinkDevice({ initialCode }: { initialCode: string }) {
  const t = useTranslations("tvLink");
  const format = useFormatter();
  const [code, setCode] = useState(formatCode(initialCode));
  const [step, setStep] = useState<Step>({ kind: "enter" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const message = (c: string) =>
    c === "device_code_invalid" ? t("errors.invalid") : c === "rate_limited" ? t("errors.rateLimited") : t("errors.unknown");

  async function lookup(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error: failure } = await api.POST("/auth/device/lookup", { body: { code } }).catch(() => ({ data: undefined, error: undefined }));
    setBusy(false);
    if (data) setStep({ kind: "confirm", code, device: data });
    else setError(message(errorCode(failure)));
  }

  async function decide(approve: boolean, current: string) {
    setBusy(true);
    setError(null);
    const path = approve ? "/auth/device/approve" : "/auth/device/deny";
    const { response, error: failure } = await api.POST(path, { body: { code: current } }).catch(() => ({ response: undefined, error: undefined }));
    setBusy(false);
    if (response?.ok) setStep({ kind: approve ? "done" : "declined" });
    else {
      setError(message(errorCode(failure)));
      setStep({ kind: "enter" });
    }
  }

  if (step.kind === "done" || step.kind === "declined") {
    return (
      <div className="flex flex-col items-start gap-4">
        <h1 className="text-4xl sm:text-5xl">{step.kind === "done" ? t("doneTitle") : t("declinedTitle")}</h1>
        <p className="text-soft">{step.kind === "done" ? t("doneBody") : t("declinedBody")}</p>
        <ButtonLink href="/" variant="secondary">
          {t("home")}
        </ButtonLink>
      </div>
    );
  }

  if (step.kind === "confirm") {
    const started = format.relativeTime(new Date(step.device.created_at));
    return (
      <div className="flex flex-col gap-5">
        <h1 className="text-4xl sm:text-5xl">{t("confirmTitle")}</h1>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-ui border border-line bg-surface p-5 text-sm">
          <dt className="text-muted">{t("device")}</dt>
          <dd className="font-bold">{deviceName(step.device.user_agent, t)}</dd>
          <dt className="text-muted">{t("code")}</dt>
          <dd className="font-bold tracking-[0.12em] tabular-nums text-accent">{step.code}</dd>
          <dt className="text-muted">{t("started")}</dt>
          <dd>{started}</dd>
          {step.device.ip && (
            <>
              <dt className="text-muted">{t("address")}</dt>
              <dd className="tabular-nums">{step.device.ip}</dd>
            </>
          )}
        </dl>
        <p className="text-sm text-muted">{t("warning")}</p>
        <div className="flex flex-wrap gap-3">
          <Button onClick={() => decide(true, step.code)} disabled={busy}>
            {t("approve")}
          </Button>
          <Button variant="secondary" onClick={() => decide(false, step.code)} disabled={busy}>
            {t("deny")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={lookup} className="flex flex-col gap-4">
      <h1 className="text-4xl sm:text-5xl">{t("title")}</h1>
      <p className="text-soft">{t("intro")}</p>
      <Field
        label={t("code")}
        value={code}
        onChange={(e) => setCode(formatCode(e.target.value))}
        placeholder="BCDF-GHJK"
        autoComplete="one-time-code"
        autoCapitalize="characters"
        spellCheck={false}
        inputMode="text"
        required
        className="text-lg font-bold tracking-[0.12em]"
      />
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy || code.replace("-", "").length !== 8} className="self-start">
        {t("continue")}
      </Button>
    </form>
  );
}

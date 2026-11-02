"use client";

import { errorCode } from "@app/api-client";
import { useTranslations } from "next-intl";
import QRCode from "qrcode";
import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import { api } from "@/lib/api";

export type TwoFactorStatus = { enabled: boolean; backup_codes_left: number };

type Step =
  | { kind: "idle" }
  | { kind: "password" }
  | { kind: "scan"; secret: string; uri: string }
  | { kind: "codes"; codes: string[] }
  | { kind: "confirm"; action: "disable" | "codes" };

/** The QR is drawn as inline SVG: the page's CSP only allows https images, not data: URLs. */
function Qr({ uri, label }: { uri: string; label: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toString(uri, { type: "svg", margin: 1, color: { dark: "#000000", light: "#ffffff" } })
      .then((out) => live && setSvg(out))
      .catch(() => live && setSvg(null));
    return () => {
      live = false;
    };
  }, [uri]);
  if (!svg) return <div className="h-48 w-48 rounded-ui bg-line" />;
  return (
    <div
      role="img"
      aria-label={label}
      className="h-48 w-48 shrink-0 overflow-hidden rounded-ui bg-white p-1 [&>svg]:h-full [&>svg]:w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export function TwoFactorPanel({ status }: { status: TwoFactorStatus }) {
  const t = useTranslations("account.twoFactor");
  const tErr = useTranslations("errors");
  const toast = useToast();
  const [state, setState] = useState(status);
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reset(next: Step = { kind: "idle" }) {
    setStep(next);
    setPassword("");
    setCode("");
    setProblem(null);
  }

  /** Runs one API call; shows the translated error and returns false when it fails. */
  async function run(call: () => Promise<{ response: Response; error?: unknown }>) {
    setBusy(true);
    setProblem(null);
    try {
      const result = await call();
      if (!result.response.ok) {
        const c = errorCode(result.error);
        setProblem(tErr.has(c) ? tErr(c) : tErr("unknown"));
        return null;
      }
      return result;
    } catch {
      setProblem(tErr("network"));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function begin(e: FormEvent) {
    e.preventDefault();
    const result = await run(() => api.POST("/me/2fa/setup", { body: { password } }));
    const data = result && "data" in result ? (result.data as { secret: string; otpauth_uri: string } | undefined) : undefined;
    if (data) reset({ kind: "scan", secret: data.secret, uri: data.otpauth_uri });
  }

  async function enable(e: FormEvent) {
    e.preventDefault();
    const result = await run(() => api.POST("/me/2fa/enable", { body: { code } }));
    const data = result && "data" in result ? (result.data as { backup_codes: string[] } | undefined) : undefined;
    if (data) {
      setState({ enabled: true, backup_codes_left: data.backup_codes.length });
      reset({ kind: "codes", codes: data.backup_codes });
    }
  }

  async function confirm(e: FormEvent, action: "disable" | "codes") {
    e.preventDefault();
    if (action === "disable") {
      const result = await run(() => api.POST("/me/2fa/disable", { body: { password, code } }));
      if (result) {
        setState({ enabled: false, backup_codes_left: 0 });
        reset();
        toast(t("disabled"), "success");
      }
      return;
    }
    const result = await run(() => api.POST("/me/2fa/backup-codes", { body: { password, code } }));
    const data = result && "data" in result ? (result.data as { backup_codes: string[] } | undefined) : undefined;
    if (data) {
      setState({ enabled: true, backup_codes_left: data.backup_codes.length });
      reset({ kind: "codes", codes: data.backup_codes });
    }
  }

  async function copyCodes(codes: string[]) {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      toast(t("copied"), "success");
    } catch {
      toast(t("copyFailed"), "error");
    }
  }

  const error = problem && (
    <p role="alert" className="text-sm text-danger">
      {problem}
    </p>
  );

  if (step.kind === "password") {
    return (
      <form onSubmit={begin} className="flex max-w-sm flex-col gap-4">
        <p className="text-sm text-muted">{t("passwordIntro")}</p>
        <Field label={t("password")} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
        {error}
        <div className="flex gap-2">
          <Button type="submit" disabled={busy || !password}>
            {t("continue")}
          </Button>
          <Button variant="ghost" onClick={() => reset()}>
            {t("cancel")}
          </Button>
        </div>
      </form>
    );
  }

  if (step.kind === "scan") {
    return (
      <form onSubmit={enable} className="flex flex-col gap-4">
        <p className="text-sm text-muted">{t("scanIntro")}</p>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <Qr uri={step.uri} label={t("qrLabel")} />
          <div className="min-w-0">
            <p className="text-sm text-muted">{t("manualKey")}</p>
            <p className="break-all font-mono text-sm tracking-wider" data-testid="totp-secret">
              {step.secret.match(/.{1,4}/g)?.join(" ")}
            </p>
          </div>
        </div>
        <div className="max-w-xs">
          <Field
            label={t("enterCode")}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]*"
            maxLength={7}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
          />
        </div>
        {error}
        <div className="flex gap-2">
          <Button type="submit" disabled={busy || code.replace(/\s/g, "").length !== 6}>
            {t("turnOn")}
          </Button>
          <Button variant="ghost" onClick={() => reset()}>
            {t("cancel")}
          </Button>
        </div>
      </form>
    );
  }

  if (step.kind === "codes") {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm">{t("codesIntro")}</p>
        <ul className="grid max-w-sm grid-cols-2 gap-2 font-mono text-sm" aria-label={t("codesLabel")}>
          {step.codes.map((c) => (
            <li key={c} className="rounded-ui border border-line bg-bg px-3 py-2">
              {c}
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => void copyCodes(step.codes)}>
            {t("copy")}
          </Button>
          <Button onClick={() => reset()}>{t("saved")}</Button>
        </div>
      </div>
    );
  }

  if (step.kind === "confirm") {
    const { action } = step;
    return (
      <form onSubmit={(e) => void confirm(e, action)} className="flex max-w-sm flex-col gap-4">
        <p className="text-sm text-muted">{t(action === "disable" ? "disableIntro" : "newCodesIntro")}</p>
        <Field label={t("password")} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
        <Field label={t("codeOrBackup")} autoComplete="one-time-code" autoCapitalize="none" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} required />
        {error}
        <div className="flex gap-2">
          <Button type="submit" disabled={busy || !password || !code}>
            {t(action === "disable" ? "disable" : "newCodes")}
          </Button>
          <Button variant="ghost" onClick={() => reset()}>
            {t("cancel")}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">{t("intro")}</p>
      {state.enabled ? (
        <>
          <p className="font-medium">
            <span className="mr-3 rounded-full bg-accent-deep px-2.5 py-0.5 text-xs">{t("on")}</span>
            {t("codesLeft", { count: state.backup_codes_left })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => reset({ kind: "confirm", action: "codes" })}>
              {t("newCodes")}
            </Button>
            <Button variant="secondary" onClick={() => reset({ kind: "confirm", action: "disable" })}>
              {t("disable")}
            </Button>
          </div>
        </>
      ) : (
        <div>
          <Button onClick={() => reset({ kind: "password" })}>{t("setUp")}</Button>
        </div>
      )}
    </div>
  );
}

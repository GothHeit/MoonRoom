"use client";

import QRCode from "qrcode";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { Skeleton } from "@/components/ui/Skeleton";
import { useRouter } from "@/i18n/navigation";
import { APP_NAME } from "@/lib/brand";

import { TvButton } from "./TvButton";
import { TvGroup } from "./TvGroup";
import { TvPillLink } from "./TvPillLink";
import { setFocus } from "./spatial";

type Code = { code: string; expiresAt: number; interval: number };
type State =
  | { kind: "loading" }
  | { kind: "showing"; login: Code }
  | { kind: "expired" }
  | { kind: "declined" }
  | { kind: "error"; code: string };

/** The address the phone opens. No locale in it: the phone's own language applies. */
function linkUrl(code?: string) {
  const url = new URL("/link", window.location.origin);
  if (code) url.searchParams.set("code", code);
  return url;
}

const noSubscribe = () => () => {};

function useQr(text: string | null) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    if (!text) return;
    let live = true;
    // Dark modules on the light text colour: high contrast for phone cameras, still on palette.
    const css = getComputedStyle(document.documentElement);
    const dark = css.getPropertyValue("--color-bg").trim();
    const light = css.getPropertyValue("--color-fg").trim();
    QRCode.toString(text, { type: "svg", margin: 2, errorCorrectionLevel: "M", color: { dark, light } })
      .then((out) => live && setSvg(out))
      .catch(() => live && setSvg(null));
    return () => {
      live = false;
    };
  }, [text]);
  return text ? svg : null;
}

function Countdown({ until }: { until: number }) {
  const t = useTranslations("tv.login");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.round((until - now) / 1000));
  const time = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  return <p className="mt-6 text-[1.5rem] text-muted tabular-nums">{t("expiresIn", { time })}</p>;
}

/**
 * Signing a TV in: it shows a short code and a QR, a signed-in phone approves it at /link, and
 * this screen, polling every few seconds, lands on Home as soon as it is approved.
 */
export function TvLogin() {
  const t = useTranslations("tv.login");
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });

  const start = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const res = await fetch("/api/auth/device/start", { method: "POST" });
      const data = await res.json().catch(() => undefined);
      if (!res.ok) {
        setState({ kind: "error", code: (data as { error?: { code?: string } } | undefined)?.error?.code ?? "unknown" });
        return;
      }
      const { user_code, expires_in, interval } = data as { user_code: string; expires_in: number; interval: number };
      setState({ kind: "showing", login: { code: user_code, expiresAt: Date.now() + expires_in * 1000, interval } });
    } catch {
      setState({ kind: "error", code: "network" });
    }
  }, []);

  useEffect(() => {
    // Fetching the first code on arrival is the point of this screen.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- starts an async request
    void start();
  }, [start]);

  const login = state.kind === "showing" ? state.login : null;
  useEffect(() => {
    if (!login) return;
    let live = true;
    let wait = login.interval * 1000;
    let timer = 0;
    const poll = async () => {
      if (!live) return;
      if (Date.now() > login.expiresAt) {
        setState({ kind: "expired" });
        return;
      }
      try {
        const res = await fetch("/api/auth/device/poll", { method: "POST" });
        if (!live) return;
        if (res.status === 204) {
          // Fresh from the server, so Home is built with the new session.
          router.replace("/tv");
          router.refresh();
          return;
        }
        if (res.status === 410) return setState({ kind: "expired" });
        if (res.status === 403) return setState({ kind: "declined" });
        // Too fast for the server (several TVs behind one address): back off.
        if (res.status === 429) wait = Math.min(wait * 2, 30_000);
      } catch {
        // The connection dropped for a moment: keep trying.
      }
      timer = window.setTimeout(poll, wait);
    };
    timer = window.setTimeout(poll, wait);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [login, router]);

  const qr = useQr(login ? linkUrl(login.code).toString() : null);
  const stopped = state.kind !== "showing" && state.kind !== "loading";
  // A dead code leaves one useful thing to press: put the remote on it.
  useEffect(() => {
    if (stopped) void setFocus("tv-login-retry");
  }, [stopped]);
  const address = useSyncExternalStore(noSubscribe, () => `${window.location.host}/link`, () => "");

  return (
    <div className="grid min-h-dvh grid-cols-[minmax(0,1fr)_auto] items-center gap-24 px-[calc(var(--tv-x)*2)] py-20">
      <TvGroup top className="min-w-0">
        <Image src="/logo-lockup.svg" alt={APP_NAME} width={250} height={60} unoptimized priority className="h-[3.75rem] w-auto" />
        <h1 className="mt-14 text-[5.5rem] leading-[0.95] tracking-[-0.02em]">{t("title")}</h1>
        {state.kind === "showing" || state.kind === "loading" ? (
          <>
            <ol className="mt-10 space-y-4 text-[1.75rem] text-soft">
              <li>
                <span className="inline-block w-12 font-display text-[2.25rem] leading-none text-numeral">1</span>
                {t.rich("step1", { address: () => <strong className="font-bold text-fg">{address}</strong> })}
              </li>
              <li>
                <span className="inline-block w-12 font-display text-[2.25rem] leading-none text-numeral">2</span>
                {t("step2")}
              </li>
            </ol>
            {login ? (
              <>
                <p aria-label={t("codeLabel")} className="mt-10 font-bold tabular-nums tracking-[0.12em] text-accent text-[6.5rem] leading-none">
                  {login.code}
                </p>
                <Countdown until={login.expiresAt} />
              </>
            ) : (
              <Skeleton className="mt-10 h-[6.5rem] w-[38rem]" />
            )}
            <p role="status" className="mt-4 text-[1.5rem] text-muted">
              {login ? t("waiting") : ""}
            </p>
          </>
        ) : (
          <div className="mt-10">
            <p className="text-[2rem] text-soft">
              {state.kind === "expired" ? t("expired") : state.kind === "declined" ? t("declined") : state.code === "rate_limited" ? t("rateLimited") : t("failed")}
            </p>
            <div className="mt-8">
              <TvButton variant="primary" focusKey="tv-login-retry" onPress={() => void start()}>
                {t("newCode")}
              </TvButton>
            </div>
          </div>
        )}
        <div className="mt-12">
          <TvPillLink href="/login?next=/tv" variant="secondary" focusKey="tv-login-password">
            {t("password")}
          </TvPillLink>
        </div>
      </TvGroup>
      <figure className={`flex flex-col items-center ${stopped ? "invisible" : ""}`}>
        <div className="flex aspect-square w-[26rem] items-center justify-center overflow-hidden rounded-ui bg-surface">
          {qr ? (
            // The SVG comes from the qrcode library, built from our own address.
            <div aria-hidden="true" className="h-full w-full [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: qr }} />
          ) : (
            <Skeleton className="h-full w-full rounded-none" />
          )}
        </div>
        <figcaption className="mt-6 max-w-[26rem] text-center text-[1.5rem] text-muted">{t("scan")}</figcaption>
      </figure>
    </div>
  );
}

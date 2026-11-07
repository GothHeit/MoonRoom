"use client";

import { errorCode } from "@app/api-client";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { Avatar } from "@/components/ui/Avatar";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import type { AvatarInfo } from "@/lib/avatar";
import { APP_NAME } from "@/lib/brand";

import { isBack } from "./keys";
import { TvButton } from "./TvButton";
import { TvGroup } from "./TvGroup";
import { TvPage } from "./TvPage";
import { useTvFocus } from "./useTvFocus";

const MAX_PIN = 6;
const MIN_PIN = 4;
const PAD = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

type Props = { userId: string; username: string; avatar: AvatarInfo };

/**
 * Shown instead of the whole TV mode while the TV session is locked. The pad works with the
 * arrows and Enter, and the remote's number keys type straight into it. The API refuses every
 * other request until the right PIN is entered, so this screen is not what protects the account.
 */
export function TvPinScreen({ userId, username, avatar }: Props) {
  const t = useTranslations("tv.pin");
  const router = useRouter();
  const [digits, setDigits] = useState("");
  const [problem, setProblem] = useState<"wrong" | "rate_limited" | "failed" | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(
    async (pin: string) => {
      if (pin.length < MIN_PIN) return;
      setBusy(true);
      setProblem(null);
      try {
        const { response, error } = await api.POST("/auth/pin/unlock", { body: { pin } });
        if (response.ok) {
          // Fresh from the server, so the screens are built now that the TV is unlocked.
          router.refresh();
          return;
        }
        const code = errorCode(error);
        setProblem(code === "wrong_pin" ? "wrong" : code === "rate_limited" ? "rate_limited" : "failed");
      } catch {
        setProblem("failed");
      }
      setDigits("");
      setBusy(false);
    },
    [router],
  );

  const press = useCallback(
    (digit: string) => {
      if (busy) return;
      setProblem(null);
      const next = (digits + digit).slice(0, MAX_PIN);
      setDigits(next);
      if (next.length === MAX_PIN) void submit(next);
    },
    [busy, digits, submit],
  );

  // Back and "Switch account" leave for the account picker; the lock stays until the right PIN.
  const switchAccount = useCallback(() => router.push("/tv/accounts?back"), [router]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Backspace") {
        setDigits((d) => d.slice(0, -1));
      } else if (isBack(event)) {
        event.preventDefault();
        switchAccount();
      } else if (/^[0-9]$/.test(event.key)) {
        event.preventDefault();
        press(event.key);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press, switchAccount]);

  const message = problem === "wrong" ? t("wrong") : problem === "rate_limited" ? t("rateLimited") : problem === "failed" ? t("failed") : "";
  const slots = Math.max(MIN_PIN, digits.length);

  return (
    <TvPage bare initial="tv-pin-5">
      <div data-tv-pin className="grid min-h-dvh grid-cols-[auto_auto] items-center justify-center gap-x-[9rem] px-[var(--tv-x)] py-16">
        <div className="flex flex-col items-start gap-10">
          <Image src="/logo-lockup.svg" alt={APP_NAME} width={250} height={60} unoptimized priority className="h-[3.25rem] w-auto" />
          <Avatar userId={userId} username={username} avatar={avatar} size={160} />
          <div>
            <h1 className="text-[5rem] leading-[0.95] tracking-[-0.02em]">{t("title")}</h1>
            <p className="mt-4 text-[1.75rem] text-soft">{t("locked", { name: username })}</p>
          </div>
          <div role="img" aria-label={t("entered", { count: digits.length })} className="flex h-10 items-center gap-5">
            {Array.from({ length: slots }, (_, i) => (
              <span key={i} className={`size-7 rounded-full border-2 ${i < digits.length ? "border-accent bg-accent" : "border-line-strong"}`} />
            ))}
          </div>
          <p role="alert" className="min-h-[2.25rem] text-[1.75rem] text-danger">
            {message}
          </p>
          <TvGroup>
            <TvButton focusKey="tv-pin-switch" disabled={busy} onPress={switchAccount}>
              {t("switch")}
            </TvButton>
          </TvGroup>
        </div>
        <TvGroup className="grid grid-cols-3 gap-5">
          {PAD.map((d) => (
            <Key key={d} focusKey={`tv-pin-${d}`} label={d} disabled={busy} onPress={() => press(d)}>
              {d}
            </Key>
          ))}
          <Key focusKey="tv-pin-delete" label={t("delete")} disabled={busy || !digits} onPress={() => setDigits((d) => d.slice(0, -1))}>
            <svg aria-hidden="true" viewBox="0 0 24 24" className="size-10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 5H9l-6 7 6 7h12z" />
              <path d="m13 9 4 6m0-6-4 6" />
            </svg>
          </Key>
          <Key focusKey="tv-pin-0" label="0" disabled={busy} onPress={() => press("0")}>
            0
          </Key>
          <Key focusKey="tv-pin-unlock" label={t("unlock")} primary disabled={busy || digits.length < MIN_PIN} onPress={() => void submit(digits)}>
            <svg aria-hidden="true" viewBox="0 0 24 24" className="size-10" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="m5 12 5 5 9-10" />
            </svg>
          </Key>
        </TvGroup>
      </div>
    </TvPage>
  );
}

/** A round key of the pad: flat, a lilac ring and a small grow when the remote is on it. */
function Key({ focusKey, label, primary, disabled, onPress, children }: { focusKey: string; label: string; primary?: boolean; disabled?: boolean; onPress: () => void; children: React.ReactNode }) {
  const { ref, focused } = useTvFocus<HTMLButtonElement>({ focusKey, onEnter: () => !disabled && onPress() });
  const look = primary ? "border-accent bg-accent text-on-accent" : focused ? "border-accent bg-surface text-fg" : "border-line-strong bg-surface text-fg";
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onPress}
      className={`flex size-[6.5rem] items-center justify-center rounded-full border-2 text-[2.5rem] font-bold outline-[3px] outline-offset-4 outline-solid transition-transform duration-[160ms] ease-out disabled:opacity-40 ${look} ${focused ? "scale-[1.08] outline-accent" : "outline-transparent"}`}
    >
      {children}
    </button>
  );
}

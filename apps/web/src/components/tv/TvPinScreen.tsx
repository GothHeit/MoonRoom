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

import { TvButton } from "./TvButton";
import { TvGroup } from "./TvGroup";
import { TvPage } from "./TvPage";

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

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (/^[0-9]$/.test(event.key)) {
        event.preventDefault();
        press(event.key);
      } else if (event.key === "Backspace") {
        setDigits((d) => d.slice(0, -1));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press]);

  const message = problem === "wrong" ? t("wrong") : problem === "rate_limited" ? t("rateLimited") : problem === "failed" ? t("failed") : "";
  const slots = Math.max(MIN_PIN, digits.length);

  return (
    <TvPage bare initial="tv-pin-5">
      <div className="flex min-h-dvh flex-col items-center justify-center gap-10 px-[var(--tv-x)] py-16 text-center">
        <Image src="/logo-lockup.svg" alt={APP_NAME} width={250} height={60} unoptimized priority className="h-[3.75rem] w-auto" />
        <div className="flex items-center gap-6">
          <Avatar userId={userId} username={username} avatar={avatar} size={96} />
          <div className="text-left">
            <h1 className="text-[4rem] leading-none">{t("title")}</h1>
            <p className="mt-3 text-[1.75rem] text-soft">{t("locked", { name: username })}</p>
          </div>
        </div>
        <div role="img" aria-label={t("entered", { count: digits.length })} className="flex h-8 items-center gap-6">
          {Array.from({ length: slots }, (_, i) => (
            <span key={i} className={`size-6 rounded-full border-2 ${i < digits.length ? "border-accent bg-accent" : "border-line-strong"}`} />
          ))}
        </div>
        <p role="alert" className="min-h-[2.25rem] text-[1.75rem] text-danger">
          {message}
        </p>
        <TvGroup className="grid grid-cols-3 gap-4">
          {PAD.map((d) => (
            <TvButton key={d} focusKey={`tv-pin-${d}`} disabled={busy} onPress={() => press(d)} className="min-w-[8rem]">
              {d}
            </TvButton>
          ))}
          <TvButton focusKey="tv-pin-delete" disabled={busy || !digits} onPress={() => setDigits((d) => d.slice(0, -1))} className="min-w-[8rem] !text-[1.5rem]">
            {t("delete")}
          </TvButton>
          <TvButton focusKey="tv-pin-0" disabled={busy} onPress={() => press("0")} className="min-w-[8rem]">
            0
          </TvButton>
          <TvButton focusKey="tv-pin-unlock" variant="primary" disabled={busy || digits.length < MIN_PIN} onPress={() => void submit(digits)} className="min-w-[8rem] !text-[1.5rem]">
            {t("unlock")}
          </TvButton>
        </TvGroup>
      </div>
    </TvPage>
  );
}

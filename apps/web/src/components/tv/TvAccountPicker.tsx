"use client";

import { errorCode } from "@app/api-client";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Avatar } from "@/components/ui/Avatar";
import { useRouter } from "@/i18n/navigation";
import { APP_NAME } from "@/lib/brand";
import type { TvAccount } from "@/lib/tv-accounts";

import { TvGroup } from "./TvGroup";
import { useTvFocus } from "./useTvFocus";

const BALL = "size-[12rem]";
// The focused ball grows to 1.06 with a 3px lilac ring, like the cards; its name brightens.
const RING =
  "rounded-full outline-[3px] outline-offset-4 outline-solid outline-transparent transition-transform duration-[160ms] ease-out group-data-[focused=true]:scale-[1.06] group-data-[focused=true]:outline-accent";
const NAME = "mt-6 block max-w-[14rem] truncate text-center text-[1.75rem] font-bold text-soft group-data-[focused=true]:text-fg";

function Ball({ focusKey, label, onPress, disabled, children }: { focusKey: string; label: string; onPress: () => void; disabled?: boolean; children: React.ReactNode }) {
  const { ref, focused } = useTvFocus<HTMLButtonElement>({ focusKey, onEnter: () => !disabled && onPress() });
  return (
    <button
      ref={ref}
      type="button"
      data-focused={focused}
      disabled={disabled}
      aria-label={label}
      onClick={onPress}
      className="group flex w-[14rem] flex-col items-center outline-none disabled:opacity-50"
    >
      {children}
    </button>
  );
}

type Props = {
  accounts: TvAccount[];
  /** The account the TV is signed in as right now, if any. */
  activeId: string | null;
  canAdd: boolean;
  /** Came from Settings: picking the same account again simply goes back. */
  fromApp: boolean;
};

/**
 * "Who's watching?": one round picture per account on this TV, then a [+] to add another. It is
 * the first screen when the app opens. Picking a ball swaps that account in (see lib/tv-accounts)
 * and lands on Home, where the account's PIN is asked first when it has one.
 */
export function TvAccountPicker({ accounts, activeId, canAdd, fromApp }: Props) {
  const t = useTranslations("tv.accounts");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<"expired" | "failed" | null>(null);

  async function pick(account: TvAccount) {
    if (busy) return;
    if (fromApp && account.id === activeId) {
      router.back();
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch("/api/tv/accounts/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: account.id }),
      });
      if (res.ok) {
        // Fresh from the server, so the screens are built with the new session.
        router.replace("/tv");
        router.refresh();
        return;
      }
      const code = errorCode(await res.json().catch(() => undefined));
      setProblem(code === "account_expired" ? "expired" : "failed");
      // An account that can no longer sign in has just been dropped: show the list without it.
      if (code === "account_expired") router.refresh();
    } catch {
      setProblem("failed");
    }
    setBusy(false);
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-16 px-[var(--tv-x)] py-16 text-center">
      <Image src="/logo-lockup.svg" alt={APP_NAME} width={250} height={60} unoptimized priority className="h-[3.75rem] w-auto" />
      <h1 className="text-[5.5rem] leading-[0.95] tracking-[-0.02em]">{t("title")}</h1>
      <TvGroup top className="flex flex-wrap items-start justify-center gap-x-14 gap-y-12">
        {accounts.map((account) => (
          <Ball key={account.id} focusKey={`tv-account-${account.id}`} label={account.name} disabled={busy} onPress={() => void pick(account)}>
            <span className={`${BALL} ${RING} block overflow-hidden`}>
              <Avatar userId={account.id} username={account.name} avatar={account.avatar} size={192} />
            </span>
            <span className={NAME}>{account.name}</span>
          </Ball>
        ))}
        {canAdd && (
          <Ball focusKey="tv-account-add" label={t("add")} disabled={busy} onPress={() => router.push("/tv/accounts/add")}>
            <span className={`${BALL} ${RING} flex items-center justify-center border-2 border-line-strong text-fg`}>
              <svg aria-hidden="true" viewBox="0 0 24 24" className="size-16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </span>
            <span className={NAME}>{t("add")}</span>
          </Ball>
        )}
      </TvGroup>
      <p role="status" className={`min-h-[2.25rem] text-[1.75rem] ${problem ? "text-danger" : "text-muted"}`}>
        {problem === "expired" ? t("expired") : problem === "failed" ? t("failed") : !canAdd ? t("full", { max: 5 }) : busy ? t("opening") : ""}
      </p>
    </div>
  );
}

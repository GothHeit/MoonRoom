import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { TvAccountPicker } from "@/components/tv/TvAccountPicker";
import { TvPage } from "@/components/tv/TvPage";
import { ACCOUNTS_COOKIE } from "@/lib/cookies";
import { titled } from "@/lib/page-title";
import { serverApi } from "@/lib/server-api";
import { MAX_ACCOUNTS, parseParked, publicAccount, sortAccounts, type TvAccount } from "@/lib/tv-accounts";

export async function generateMetadata({ params }: PageProps<"/[locale]/tv/accounts">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "tv.accounts" });
  return titled(t("title"));
}

export default async function TvAccountsPage({ params, searchParams }: PageProps<"/[locale]/tv/accounts">) {
  const { locale } = await params;
  const { back } = await searchParams;
  setRequestLocale(locale);
  const parked = parseParked((await cookies()).get(ACCOUNTS_COOKIE)?.value);
  // Open to a TV that is waiting for its PIN: who is signed in is not a secret from the person holding the remote.
  const { data } = await (await serverApi()).GET("/auth/pin");
  const active: TvAccount | null = data ? { id: data.id, name: data.username, avatar: data.avatar } : null;
  const accounts = sortAccounts([...parked.filter((a) => a.id !== active?.id).map(publicAccount), ...(active ? [active] : [])]);
  return (
    <TvPage bare initial={`tv-account-${active?.id ?? accounts[0]?.id ?? "add"}`}>
      <TvAccountPicker accounts={accounts} activeId={active?.id ?? null} canAdd={accounts.length < MAX_ACCOUNTS} fromApp={back !== undefined} />
    </TvPage>
  );
}

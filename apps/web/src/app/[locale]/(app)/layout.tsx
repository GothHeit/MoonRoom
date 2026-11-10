import { getTranslations, setRequestLocale } from "next-intl/server";
import { Suspense } from "react";

import { PushSync } from "@/components/shell/PushSync";
import { InstallHint } from "@/components/shell/InstallHint";
import { NavProgress } from "@/components/shell/NavProgress";
import { TabBar } from "@/components/shell/TabBar";
import { TopNav } from "@/components/shell/TopNav";
import { serverApi, unwrap } from "@/lib/server-api";

export default async function AppLayout({ children, params }: LayoutProps<"/[locale]">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("nav");
  const api = await serverApi();
  // Both at once; the second is only for the badge on the account menu, so a failure just hides it.
  const [me, requests] = await Promise.all([
    unwrap(api.GET("/me"), locale),
    api.GET("/friends/requests").then((r) => r.data, () => undefined),
  ]);
  const pending = requests?.incoming.length ?? 0;

  return (
    <>
      <a
        href="#main"
        className="sr-only z-50 press inline-flex min-h-11 items-center justify-center rounded-full bg-accent px-5 py-2 font-medium text-on-accent focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        {t("skip")}
      </a>
      <Suspense>
        <NavProgress />
      </Suspense>
      <TopNav userId={me.id} username={me.username} avatar={me.avatar} isAdmin={me.is_admin} pending={pending} />
      <main id="main" tabIndex={-1} className="pb-[calc(6rem+env(safe-area-inset-bottom))] md:pb-16 short:pb-[calc(4rem+env(safe-area-inset-bottom))]">{children}</main>
      <InstallHint />
      <PushSync userId={me.id} />
      <TabBar userId={me.id} username={me.username} avatar={me.avatar} isAdmin={me.is_admin} pending={pending} />
    </>
  );
}

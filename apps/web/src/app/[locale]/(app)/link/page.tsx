import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { LinkDevice } from "@/components/link/LinkDevice";
import { titled } from "@/lib/page-title";

export async function generateMetadata({ params }: PageProps<"/[locale]/link">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "tvLink" });
  return titled(t("title"));
}

/** Where a phone approves a TV's sign-in code (the TV's QR opens it with the code filled in). */
export default async function LinkPage({ params, searchParams }: PageProps<"/[locale]/link">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const raw = (await searchParams).code;
  const code = (Array.isArray(raw) ? raw[0] : raw)?.slice(0, 16) ?? "";
  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 px-4 pb-8 pt-24 sm:px-8">
      <LinkDevice initialCode={code} />
    </div>
  );
}

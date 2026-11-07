import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { AuthCard } from "@/components/auth/AuthCard";
import { LoginForm } from "@/components/auth/LoginForm";
import { Link } from "@/i18n/navigation";
import { titled } from "@/lib/page-title";
import { safeNext } from "@/lib/redirect";

export async function generateMetadata({ params }: PageProps<"/[locale]/login">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "login" });
  return titled(t("title"));
}

export default async function LoginPage({ params, searchParams }: PageProps<"/[locale]/login">) {
  const { locale } = await params;
  const { next } = await searchParams;
  // Someone scanning a TV's code without an account creates one and lands back on the code.
  const back = safeNext(typeof next === "string" ? next : null);
  setRequestLocale(locale);
  const t = await getTranslations("login");

  return (
    <AuthCard
      title={t("title")}
      footer={
        <>
          {t("noAccount")}{" "}
          <Link href={back === "/" ? "/register" : { pathname: "/register", query: { next: back } }} className="font-bold text-accent hover:underline">
            {t("registerLink")}
          </Link>
        </>
      }
    >
      <LoginForm />
    </AuthCard>
  );
}

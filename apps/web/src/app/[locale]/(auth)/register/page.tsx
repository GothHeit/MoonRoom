import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { AuthCard } from "@/components/auth/AuthCard";
import { RegisterForm } from "@/components/auth/RegisterForm";
import { Link } from "@/i18n/navigation";
import { titled } from "@/lib/page-title";
import { safeNext } from "@/lib/redirect";

export async function generateMetadata({ params }: PageProps<"/[locale]/register">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "register" });
  return titled(t("title"));
}

export default async function RegisterPage({ params, searchParams }: PageProps<"/[locale]/register">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("register");
  const { invite, next } = await searchParams;
  const back = safeNext(typeof next === "string" ? next : null);

  return (
    <AuthCard
      title={t("title")}
      footer={
        <>
          {t("haveAccount")}{" "}
          <Link href={back === "/" ? "/login" : { pathname: "/login", query: { next: back } }} className="font-bold text-accent hover:underline">
            {t("loginLink")}
          </Link>
        </>
      }
    >
      <RegisterForm initialCode={typeof invite === "string" ? invite : undefined} />
    </AuthCard>
  );
}

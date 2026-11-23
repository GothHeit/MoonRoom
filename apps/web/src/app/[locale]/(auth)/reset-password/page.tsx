import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { AuthCard } from "@/components/auth/AuthCard";
import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";
import { Link } from "@/i18n/navigation";
import { titled } from "@/lib/page-title";

export async function generateMetadata({ params }: PageProps<"/[locale]/reset-password">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "resetPassword" });
  return { ...titled(t("title")), robots: { index: false, follow: false } };
}

export default async function ResetPasswordPage({ params }: PageProps<"/[locale]/reset-password">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("resetPassword");

  return (
    <AuthCard
      title={t("title")}
      footer={
        <Link href="/login" className="font-bold text-accent hover:underline">
          {t("back")}
        </Link>
      }
    >
      {/* The token is in the address after the #, which the browser never sends anywhere. */}
      <ResetPasswordForm />
    </AuthCard>
  );
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { MessagesView } from "@/components/messages/MessagesView";
import { titled } from "@/lib/page-title";
import { serverApi, unwrap } from "@/lib/server-api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({ params }: PageProps<"/[locale]/messages/[[...chat]]">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "messages" });
  return titled(t("title"));
}

export default async function MessagesPage({ params }: PageProps<"/[locale]/messages/[[...chat]]">) {
  const { locale, chat } = await params;
  setRequestLocale(locale);
  if (chat && (chat.length > 1 || !UUID.test(chat[0]))) notFound();
  const me = await unwrap((await serverApi()).GET("/me"), locale);
  return <MessagesView selected={chat?.[0]} meId={me.id} />;
}

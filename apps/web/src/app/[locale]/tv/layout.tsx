import type { Metadata } from "next";
import { headers } from "next/headers";
import { setRequestLocale } from "next-intl/server";

import { TvPinGuard } from "@/components/tv/TvPinGuard";
import { TvPinScreen } from "@/components/tv/TvPinScreen";
import { TvRoot } from "@/components/tv/TvRoot";
import { APP_NAME } from "@/lib/brand";
import { serverApi } from "@/lib/server-api";

export const metadata: Metadata = { title: `TV · ${APP_NAME}` };

/**
 * The TV mode: the site laid out for a television and its remote. When the account has a PIN
 * the TV session starts locked, and while it is the screens below are not even built: the API
 * refuses them, and this layout shows the PIN pad instead.
 */
export default async function TvLayout({ children, params }: LayoutProps<"/[locale]/tv">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const api = await serverApi();
  // A signed-out TV gets a 401 here and no data: the pages below send it to sign in.
  let { data: pin } = await api.GET("/auth/pin");
  // Opening the app (a full page load, not a move inside it) always asks for the PIN again.
  const opening = (await headers()).get("sec-fetch-mode") === "navigate";
  if (pin?.enabled && opening && !pin.locked) {
    await api.POST("/auth/pin/lock");
    pin = (await api.GET("/auth/pin")).data;
  }
  if (pin?.locked) {
    return (
      <TvRoot>
        <TvPinScreen userId={pin.id} username={pin.username} avatar={pin.avatar} />
      </TvRoot>
    );
  }
  return (
    <TvRoot>
      {pin?.enabled && <TvPinGuard />}
      {children}
    </TvRoot>
  );
}

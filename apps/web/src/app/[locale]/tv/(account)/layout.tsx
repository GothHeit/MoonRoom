import { headers } from "next/headers";
import { setRequestLocale } from "next-intl/server";

import { TvPinGuard } from "@/components/tv/TvPinGuard";
import { TvPinScreen } from "@/components/tv/TvPinScreen";
import { serverApi } from "@/lib/server-api";

/**
 * The screens of a signed-in TV. When the account has a PIN the TV session starts locked, and
 * while it is the screens below are not even built: the API refuses them, and this layout shows
 * the PIN pad instead. (The account picker and the sign-in screens sit outside it: they must
 * show before anyone has entered a PIN.)
 */
export default async function TvAccountLayout({ children, params }: LayoutProps<"/[locale]/tv">) {
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
  if (pin?.locked) return <TvPinScreen userId={pin.id} username={pin.username} avatar={pin.avatar} />;
  return (
    <>
      {pin?.enabled && <TvPinGuard />}
      {children}
    </>
  );
}

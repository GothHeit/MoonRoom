import { setRequestLocale } from "next-intl/server";

import { TvNav } from "@/components/tv/TvNav";
import { serverApi, unwrap } from "@/lib/server-api";

export default async function TvShellLayout({ children, params }: LayoutProps<"/[locale]/tv">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const me = await unwrap((await serverApi()).GET("/me"), locale, "tv");
  return (
    <>
      <TvNav userId={me.id} username={me.username} avatar={me.avatar} />
      <main id="main">{children}</main>
    </>
  );
}

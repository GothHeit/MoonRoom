import { useTranslations } from "next-intl";

import { Link } from "@/i18n/navigation";

export type EndReason = "room_not_found" | "room_full" | "not_authenticated" | "network";

/** Why a viewer is no longer in the room, with the one way on from here. */
export function RoomEnded({ reason }: { reason: EndReason }) {
  const t = useTranslations("room");
  const signIn = reason === "not_authenticated";
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-bg p-6 text-fg">
      <div role="alert" className="flex max-w-md flex-col items-center gap-4 text-center">
        <h1 className="font-display text-4xl leading-tight">{t(`ended.${reason}`)}</h1>
        <p className="text-soft">{t(`closed.${reason}`)}</p>
        <Link
          href={signIn ? "/login" : "/room"}
          className="press mt-2 inline-flex min-h-11 items-center justify-center rounded-full bg-accent px-6 text-sm font-bold text-on-accent"
        >
          {signIn ? t("signIn") : t("back")}
        </Link>
      </div>
    </div>
  );
}

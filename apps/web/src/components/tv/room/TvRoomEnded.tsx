"use client";

import { useTranslations } from "next-intl";

import type { EndReason } from "@/components/room/RoomEnded";
import { useRouter } from "@/i18n/navigation";

import { TvButton } from "../TvButton";
import { TvNotice } from "../TvNotice";
import { tvHref } from "../paths";

const HOME_KEY = "tv-room-home";

/**
 * Why this TV is no longer in the room (it ended, it is full), with the way back to Home. A TV
 * never types a room code, so an ended room is said plainly.
 */
export function TvRoomEnded({ reason }: { reason: EndReason }) {
  const t = useTranslations("room");
  const tv = useTranslations("tv.room");
  const router = useRouter();
  return (
    <TvNotice bare alert initial={HOME_KEY} title={t(`ended.${reason}`)} body={reason === "room_not_found" ? tv("endedBody") : t(`closed.${reason}`)}>
      <TvButton variant="primary" focusKey={HOME_KEY} onPress={() => router.replace(tvHref("/"))}>
        {tv("home")}
      </TvButton>
    </TvNotice>
  );
}

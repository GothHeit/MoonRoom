"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { Switch } from "@/components/account/Switch";
import { useToast } from "@/components/ui/Toast";
import { api } from "@/lib/api";

const KINDS = ["friend_request", "friend_accepted", "room_invite", "new_episode", "new_chapter"] as const;

/** One switch per kind of notification, saved as soon as it is flipped. */
export function NotificationsForm({ muted }: { muted: string[] }) {
  const t = useTranslations("notifications.settings");
  const toast = useToast();
  const [off, setOff] = useState(new Set(muted));
  const [busy, setBusy] = useState(false);

  async function flip(kind: string, on: boolean) {
    const next = new Set(off);
    if (on) next.delete(kind);
    else next.add(kind);
    setOff(next);
    setBusy(true);
    const { response } = await api
      .PUT("/notifications/settings", { body: { muted: [...next] } })
      .catch(() => ({ response: null }));
    setBusy(false);
    if (response?.ok) {
      toast(t("saved"), "success");
    } else {
      setOff(off);
      toast(t("saveFailed"), "error");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">{t("hint")}</p>
      {KINDS.map((kind) => (
        <div key={kind} className="flex items-center justify-between gap-4">
          <p className="font-medium">{t(kind)}</p>
          <Switch checked={!off.has(kind)} onChange={(on) => void flip(kind, on)} label={t(kind)} disabled={busy} />
        </div>
      ))}
    </div>
  );
}

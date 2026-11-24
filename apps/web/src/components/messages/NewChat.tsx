"use client";

import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";

import { Button, ButtonLink } from "@/components/ui/Button";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import type { UserSummary } from "@/lib/friends";
import { GROUP_MAX, messagesHref } from "@/lib/messages";

import { PickList, type PickKey } from "./PickList";
import { Sheet } from "./Sheet";

/** Pick one friend for a chat with them, or several (and maybe a name) for a group. */
export function NewChat({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const t = useTranslations("messages");
  const router = useRouter();
  const nameId = useId();
  const [friends, setFriends] = useState<UserSummary[] | null>(null);
  const [selected, setSelected] = useState<Set<PickKey>>(new Set());
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const ids = [...selected].map((k) => k.slice(2));

  useEffect(() => {
    void api.GET("/friends").then(
      (r) => setFriends((r.data ?? []).map((f) => f.user).sort((a, b) => a.username.localeCompare(b.username))),
      () => setFriends([]),
    );
  }, []);

  async function start() {
    setBusy(true);
    setError(false);
    const { data } =
      ids.length === 1
        ? await api.POST("/chats/direct", { body: { user_id: ids[0] } }).catch(() => ({ data: undefined }))
        : await api.POST("/chats/groups", { body: { user_ids: ids, name: name.trim() || null } }).catch(() => ({ data: undefined }));
    setBusy(false);
    if (!data) return setError(true);
    onCreated();
    onClose();
    router.push(messagesHref(data.id));
  }

  const empty = friends !== null && friends.length === 0;

  return (
    <Sheet
      title={t("newChat")}
      onClose={onClose}
      footer={
        empty ? (
          <ButtonLink href="/friends" className="w-full">
            {t("findFriends")}
          </ButtonLink>
        ) : (
          <>
            {error && (
              <p role="alert" className="mb-2 text-sm text-danger">
                {t("createFailed")}
              </p>
            )}
            <Button className="w-full" disabled={busy || ids.length === 0} onClick={() => void start()}>
              {ids.length > 1 ? t("createGroup") : t("start")}
            </Button>
          </>
        )
      }
    >
      {empty && <p className="px-5 py-6 text-center text-sm text-muted">{t("noFriends")}</p>}
      {friends && !empty && (
        <>
          <PickList
            friends={friends}
            selected={selected}
            onToggle={(key) =>
              setSelected((all) => {
                const next = new Set(all);
                if (next.has(key)) next.delete(key);
                else if (next.size < GROUP_MAX - 1) next.add(key);
                return next;
              })
            }
          />
          {ids.length > 1 && (
            <div className="px-4 pb-1 pt-3 sm:px-5">
              <label htmlFor={nameId} className="sr-only">
                {t("groupName")}
              </label>
              <input
                id={nameId}
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("groupName")}
                className="min-h-11 w-full rounded-ui border border-line-strong bg-bg px-4 py-2 text-base text-fg placeholder:text-muted focus:border-accent focus:outline-none"
              />
            </div>
          )}
        </>
      )}
    </Sheet>
  );
}

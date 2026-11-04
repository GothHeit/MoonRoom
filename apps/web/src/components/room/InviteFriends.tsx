"use client";

import { errorCode } from "@app/api-client";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { api } from "@/lib/api";
import type { FriendOut } from "@/lib/friends";

type Props = { code: string; memberIds: string[] };

/** Lists the friends and sends each one an invite to this room. */
export function InviteFriends({ code, memberIds }: Props) {
  const t = useTranslations("room.invite");
  const tErr = useTranslations("errors");
  const [open, setOpen] = useState(false);
  const [friends, setFriends] = useState<FriendOut[] | null>(null);
  const [sent, setSent] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next) return;
    // Fresh every time it opens: friends made since, and a clean slate for old errors.
    setError(null);
    const { data } = await api.GET("/friends").catch(() => ({ data: undefined }));
    if (data) setFriends(data);
    else if (friends === null) setError(t("loadFailed"));
  }

  async function invite(userId: string) {
    setError(null);
    const { response, error: body } = await api
      .POST("/watch/rooms/{code}/invite", { params: { path: { code } }, body: { user_id: userId } })
      .catch(() => ({ response: null, error: undefined }));
    if (response?.ok) setSent((s) => new Set(s).add(userId));
    else {
      const key = errorCode(body);
      setError(tErr.has(key) ? tErr(key) : t("failed"));
    }
  }

  const candidates = (friends ?? []).filter((f) => !memberIds.includes(f.user.id));

  return (
    <section>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => void toggle()}
        className="press min-h-11 rounded-full border border-line-strong px-4 text-sm font-bold hover:bg-line"
      >
        {t("button")}
      </button>
      {open && (
        <div className="mt-2">
          {error && (
            <p role="alert" className="mb-2 text-danger">
              {error}
            </p>
          )}
          {friends !== null && candidates.length === 0 && <p className="text-muted">{t("none")}</p>}
          <ul className="flex flex-col gap-2">
            {candidates.map(({ user }) => (
              <li key={user.id} className="flex items-center justify-between gap-2">
                <span className="truncate">{user.username}</span>
                <button
                  type="button"
                  disabled={sent.has(user.id)}
                  onClick={() => void invite(user.id)}
                  className="press min-h-11 shrink-0 rounded-full bg-accent px-4 text-sm font-bold text-on-accent disabled:opacity-60"
                >
                  {sent.has(user.id) ? t("sent") : t("send")}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

"use client";

import { errorCode } from "@app/api-client";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { api } from "@/lib/api";

export type Member = {
  id: string;
  username: string;
  locale: string;
  is_admin: boolean;
  two_factor: boolean;
  created_at: string;
};

type Link = { memberId: string; url: string; expiresAt: string };

const HOUR_CHOICES = [1, 6, 24];

/** The owner's list of accounts, with a one-time password reset link for a friend who forgot theirs. */
export function MembersPanel({ members, meId }: { members: Member[]; meId: string }) {
  const t = useTranslations("account.members");
  const tErr = useTranslations("errors");
  const format = useFormatter();
  const toast = useToast();
  const [openId, setOpenId] = useState<string | null>(null);
  const [hours, setHours] = useState(1);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<Link | null>(null);
  const [copied, setCopied] = useState(false);

  // The button says "Link copied." for a moment instead of a toast, which would cover the panel on a phone.
  function flashCopied() {
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function make(member: Member) {
    setBusy(true);
    try {
      const { data, error } = await api.POST("/admin/users/{user_id}/password-reset", {
        params: { path: { user_id: member.id } },
        body: { hours_valid: hours },
      });
      if (!data) {
        const code = errorCode(error);
        toast(tErr.has(code) ? tErr(code) : t("failed"), "error");
        return;
      }
      // The link opens in the friend's own language, and the token rides in the #fragment so it
      // never reaches a server log.
      const url = `${window.location.origin}/${data.locale}/reset-password#${encodeURIComponent(data.token)}`;
      setLink({ memberId: member.id, url, expiresAt: data.expires_at });
      try {
        await navigator.clipboard.writeText(url);
        flashCopied();
      } catch {
        // The link is on screen to copy by hand.
      }
    } catch {
      toast(t("failed"), "error");
    } finally {
      setBusy(false);
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      flashCopied();
    } catch {
      toast(t("copyFailed"), "error");
    }
  }

  function toggle(id: string) {
    setLink(null);
    setCopied(false);
    setOpenId((current) => (current === id ? null : id));
  }

  if (members.length === 0) return <p className="text-muted">{t("empty")}</p>;

  return (
    <ul className="flex flex-col gap-3">
      {members.map((member) => {
        const open = openId === member.id;
        const shown = link?.memberId === member.id ? link : null;
        return (
          <li key={member.id} className="rounded-ui border border-line bg-surface p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-lg font-bold">{member.username}</span>
                  {member.id === meId && <span className="rounded-full border border-line-strong px-2 py-0.5 text-xs text-soft">{t("you")}</span>}
                  {member.is_admin && <span className="rounded-full border border-line-strong px-2 py-0.5 text-xs text-soft">{t("admin")}</span>}
                  {member.two_factor && <span className="rounded-full border border-line-strong px-2 py-0.5 text-xs text-soft">{t("twoFactor")}</span>}
                </p>
                <p className="text-sm text-muted">{t("joined", { date: format.dateTime(new Date(member.created_at), { dateStyle: "medium" }) })}</p>
              </div>
              <Button variant="secondary" aria-expanded={open} onClick={() => toggle(member.id)}>
                {t("resetPassword")}
              </Button>
            </div>

            {open && !shown && (
              <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4">
                <label className="flex flex-col gap-1">
                  <span className="text-sm text-muted">{t("validFor")}</span>
                  <select
                    value={hours}
                    onChange={(e) => setHours(Number(e.target.value))}
                    className="h-11 rounded-ui border border-line-strong bg-bg px-3 text-base text-fg"
                  >
                    {HOUR_CHOICES.map((h) => (
                      <option key={h} value={h}>
                        {t("hours", { count: h })}
                      </option>
                    ))}
                  </select>
                </label>
                <Button onClick={() => make(member)} disabled={busy}>
                  {busy ? t("making") : t("make")}
                </Button>
              </div>
            )}

            {shown && (
              <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4">
                <p className="font-bold">{t("linkTitle", { username: member.username })}</p>
                <p className="text-sm text-muted">
                  {t("linkBody", { when: format.dateTime(new Date(shown.expiresAt), { dateStyle: "medium", timeStyle: "short" }) })}
                </p>
                <input
                  readOnly
                  value={shown.url}
                  aria-label={t("linkTitle", { username: member.username })}
                  onFocus={(e) => e.currentTarget.select()}
                  className="h-11 w-full rounded-ui border border-line-strong bg-bg px-4 text-base text-fg"
                />
                {member.two_factor && <p className="text-sm text-muted">{t("twoFactorNote")}</p>}
                <div className="flex flex-wrap gap-3">
                  <Button onClick={() => copy(shown.url)}>{copied ? t("copied") : t("copy")}</Button>
                  <Button variant="ghost" onClick={() => toggle(member.id)}>
                    {t("close")}
                  </Button>
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

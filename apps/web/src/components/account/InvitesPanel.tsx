"use client";

import { errorCode } from "@app/api-client";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";

export type Invite = { code: string; expires_at: string; used: boolean };

const DAY_CHOICES = [1, 7, 30];

export function inviteStatus(invite: Invite, now = Date.now()): "used" | "expired" | "active" {
  if (invite.used) return "used";
  return new Date(invite.expires_at).getTime() <= now ? "expired" : "active";
}

export function InvitesPanel({ invites }: { invites: Invite[] }) {
  const t = useTranslations("account.invites");
  const tErr = useTranslations("errors");
  const locale = useLocale();
  const format = useFormatter();
  const router = useRouter();
  const toast = useToast();
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);

  async function copy(code: string) {
    const link = `${window.location.origin}/${locale}/register?invite=${encodeURIComponent(code)}`;
    try {
      await navigator.clipboard.writeText(link);
      return true;
    } catch {
      return false;
    }
  }

  async function create() {
    setBusy(true);
    try {
      const { data, error } = await api.POST("/invites", { body: { days_valid: days } });
      if (!data) {
        const code = errorCode(error);
        toast(tErr.has(code) ? tErr(code) : t("createFailed"), "error");
        return;
      }
      toast((await copy(data.code)) ? t("created") : t("createdNoCopy"), "success");
      router.refresh();
    } catch {
      toast(t("createFailed"), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-sm text-muted">{t("validFor")}</span>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="rounded-ui border border-line bg-bg px-3 h-11 text-fg"
          >
            {DAY_CHOICES.map((d) => (
              <option key={d} value={d}>
                {t("days", { count: d })}
              </option>
            ))}
          </select>
        </label>
        <Button onClick={create} disabled={busy}>
          {busy ? t("creating") : t("create")}
        </Button>
      </div>

      {invites.length === 0 ? (
        <p className="text-muted">{t("empty")}</p>
      ) : (
        <div className="overflow-x-auto rounded-ui border border-line">
          <table className="w-full text-left text-sm">
            <thead className="text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-3 font-medium">{t("code")}</th>
                <th className="px-4 py-3 font-medium">{t("expires")}</th>
                <th className="px-4 py-3 font-medium">{t("status")}</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {invites.map((invite) => {
                const status = inviteStatus(invite);
                return (
                  <tr key={invite.code} className="border-b border-line last:border-0">
                    <td className="px-4 py-3 font-mono">{invite.code}</td>
                    <td className="px-4 py-3">
                      {format.dateTime(new Date(invite.expires_at), { dateStyle: "medium" })}
                    </td>
                    <td className={`px-4 py-3 ${status === "active" ? "text-success" : "text-muted"}`}>
                      {t(`status${status === "active" ? "Active" : status === "used" ? "Used" : "Expired"}`)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {status === "active" && (
                        <Button
                          variant="ghost"
                          onClick={async () => toast((await copy(invite.code)) ? t("copied") : t("copyFailed"))}
                        >
                          {t("copy")}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

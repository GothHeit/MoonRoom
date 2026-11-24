"use client";

import { errorCode } from "@app/api-client";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { postAuth } from "@/lib/bff";

import { describeAgent } from "./describeAgent";

export type LoginSession = {
  id: string;
  user_agent: string | null;
  ip: string | null;
  started_at: string;
  last_active_at: string;
  current: boolean;
};

/** How many devices show before "show all". */
const RECENT = 5;

export function SessionsPanel({ sessions }: { sessions: LoginSession[] }) {
  const t = useTranslations("account.sessions");
  const tErr = useTranslations("errors");
  const format = useFormatter();
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | "all" | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // This device first, then the ones used most recently; the rest wait behind "show all".
  const ordered = [...sessions].sort(
    (a, b) => Number(b.current) - Number(a.current) || b.last_active_at.localeCompare(a.last_active_at),
  );
  const shown = showAll ? ordered : ordered.slice(0, RECENT);

  function fail(error: unknown) {
    const code = errorCode(error);
    toast(tErr.has(code) ? tErr(code) : tErr("unknown"), "error");
  }

  async function revoke(id: string) {
    setBusy(id);
    try {
      const { response, error } = await api.DELETE("/me/sessions/{session_id}", { params: { path: { session_id: id } } });
      if (!response.ok && response.status !== 404) return fail(error);
      toast(t("revoked"), "success");
      router.refresh();
    } catch {
      fail(undefined);
    } finally {
      setBusy(null);
    }
  }

  async function revokeAll() {
    setBusy("all");
    try {
      const { response, error } = await api.DELETE("/me/sessions");
      if (!response.ok) return fail(error);
      // This device is signed out too: clear its cookies and go to the login page.
      await postAuth("logout", {});
      router.replace("/login");
      router.refresh();
    } catch {
      fail(undefined);
    } finally {
      setBusy(null);
      setConfirmingAll(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">{t("intro")}</p>
      <ul className="flex flex-col divide-y divide-line rounded-ui border border-line">
        {shown.map((s) => {
          const { browser, system } = describeAgent(s.user_agent);
          const device =
            browser && system ? t("device", { browser, system }) : (browser ?? system ?? t("unknownDevice"));
          return (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 p-4" data-testid="session">
              <div>
                <p className="font-medium">
                  {device}
                  {s.current && <span className="ml-3 rounded-ui bg-accent-deep px-2 py-0.5 text-xs">{t("thisDevice")}</span>}
                </p>
                <p className="mt-1 text-sm text-muted">
                  {s.ip ? `${s.ip} · ` : ""}
                  {t("lastActive", { when: format.relativeTime(new Date(s.last_active_at)) })}
                </p>
                <p className="text-xs text-muted">
                  {t("signedInOn", { date: format.dateTime(new Date(s.started_at), { dateStyle: "medium" }) })}
                </p>
              </div>
              {!s.current && (
                <Button variant="secondary" onClick={() => revoke(s.id)} disabled={busy !== null}>
                  {busy === s.id ? t("revoking") : t("revoke")}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-2">
        {ordered.length > RECENT && (
          <Button variant="ghost" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
            {showAll ? t("showRecent") : t("showAll", { count: ordered.length })}
          </Button>
        )}
        <Button variant="secondary" onClick={() => setConfirmingAll(true)} disabled={busy !== null}>
          {t("revokeAll")}
        </Button>
      </div>

      <Modal open={confirmingAll} onClose={() => setConfirmingAll(false)} title={t("revokeAllTitle")}>
        <p className="text-sm text-muted">{t("revokeAllBody")}</p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmingAll(false)} disabled={busy === "all"}>
            {t("cancel")}
          </Button>
          <Button onClick={revokeAll} disabled={busy === "all"}>
            {busy === "all" ? t("revoking") : t("revokeAllConfirm")}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

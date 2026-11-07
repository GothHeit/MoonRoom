"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { Switch } from "@/components/account/Switch";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { disablePush, enablePush, pushState, sendTestPush, type PushState } from "@/lib/push";

/** Phone notifications for this device: one switch, plus the steps an iPhone needs first. Which
 * kinds arrive is decided by the switches above it, the same ones the bell uses. */
export function PushForm({ publicKey }: { publicKey: string }) {
  const t = useTranslations("notifications.push");
  const toast = useToast();
  const [state, setState] = useState<PushState>("checking");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void pushState().then((s) => live && setState(s));
    return () => {
      live = false;
    };
  }, []);

  async function flip(on: boolean) {
    setBusy(true);
    try {
      if (on) {
        const next = await enablePush(publicKey);
        setState(next);
        if (next === "on") toast(t("enabled"), "success");
      } else {
        await disablePush();
        setState("off");
      }
    } catch {
      toast(t("failed"), "error");
      setState(await pushState());
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    const ok = await sendTestPush();
    setBusy(false);
    toast(ok ? t("testSent") : t("testFailed"), ok ? "success" : "error");
  }

  if (state === "checking") return null;

  if (state === "install" || state === "unsupported" || state === "denied") {
    return (
      <div className="flex flex-col gap-2 text-sm text-muted">
        <p>{t(state)}</p>
        {state === "install" && <p>{t("installSteps")}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="font-medium">{t("device")}</p>
          <p className="text-sm text-muted">{t("hint")}</p>
        </div>
        <Switch checked={state === "on"} onChange={(on) => void flip(on)} label={t("device")} disabled={busy} />
      </div>
      {state === "on" && (
        <Button variant="secondary" className="self-start" disabled={busy} onClick={() => void test()}>
          {t("test")}
        </Button>
      )}
    </div>
  );
}

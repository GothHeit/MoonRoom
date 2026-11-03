"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState, useSyncExternalStore } from "react";

import { usePathname } from "@/i18n/navigation";

const DISMISSED_KEY = "moonroom.installHint.dismissed";

type InstallPrompt = Event & { prompt: () => Promise<void> };
type Mode = "ios" | "prompt" | null;

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

/** iPhone/iPad Safari only: other iOS browsers cannot add to the Home Screen the same way. */
function isIosSafari() {
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
  return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
}

function wasDismissed() {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Phone-only nudge to install the site as an app: Share > Add to Home Screen on iOS, the native prompt on Android. */
const noopSubscribe = () => () => {};

export function InstallHint() {
  const t = useTranslations("install");
  const pathname = usePathname();
  const [hidden, setHidden] = useState(false);
  const [deferred, setDeferred] = useState<InstallPrompt | null>(null);
  // Read the browser once; false while server-rendering so hydration matches.
  // Decided once per page load, so marking it seen below does not hide it mid-visit.
  const [snap] = useState(() => ({ value: undefined as boolean | undefined }));
  const ios = useSyncExternalStore(noopSubscribe, () => (snap.value ??= !isStandalone() && !wasDismissed() && isIosSafari()), () => false);
  const onHome = pathname === "/" || pathname === "/manga";

  // Shown once: the first visit that reaches the home page counts as seen.
  useEffect(() => {
    if (!ios || !onHome) return;
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Private mode: it just comes back next visit.
    }
  }, [ios, onHome]);

  useEffect(() => {
    if (isStandalone() || wasDismissed()) return;
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as InstallPrompt);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  const mode: Mode = hidden || !onHome ? null : ios ? "ios" : deferred ? "prompt" : null;
  if (!mode) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Private mode: it just comes back next visit.
    }
    setHidden(true);
  };
  const install = async () => {
    await deferred?.prompt();
    dismiss();
  };

  return (
    <div
      role="region"
      aria-label={t("title")}
      className="fixed inset-x-3 bottom-[calc(5rem+env(safe-area-inset-bottom))] short:bottom-[calc(3.25rem+env(safe-area-inset-bottom))] short:left-auto short:max-w-md z-40 flex items-start gap-3 rounded-2xl border border-line bg-surface p-4 short:p-3 md:hidden short:flex"
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium">{t("title")}</p>
        <p className="mt-1 text-sm text-muted">{mode === "ios" ? t("ios") : t("body")}</p>
        {mode === "prompt" && (
          <button type="button" onClick={install} className="press mt-3 inline-flex min-h-11 items-center rounded-full bg-accent px-5 font-medium text-on-accent">
            {t("install")}
          </button>
        )}
      </div>
      <button type="button" onClick={dismiss} aria-label={t("dismiss")} className="press inline-flex size-11 shrink-0 items-center justify-center text-muted">
        ✕
      </button>
    </div>
  );
}

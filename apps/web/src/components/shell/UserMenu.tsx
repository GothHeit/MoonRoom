"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Link, useRouter } from "@/i18n/navigation";
import { Avatar } from "@/components/ui/Avatar";
import { postAuth } from "@/lib/bff";
import type { AvatarInfo } from "@/lib/avatar";
import { profileHref } from "@/lib/friends";
import { forgetThisDevice } from "@/lib/push";
import { usePresence } from "@/lib/use-presence";

type Props = {
  userId: string;
  username: string;
  avatar: AvatarInfo;
  isAdmin?: boolean;
  /** Friend requests waiting for an answer. */
  pending?: number;
  /** "tab" opens upward from the phone tab bar. */
  variant?: "nav" | "tab";
  trigger?: ReactNode;
  triggerClassName?: string;
};

export function UserMenu({ userId, username, avatar, isAdmin = false, pending = 0, variant = "nav", trigger, triggerClassName }: Props) {
  const t = useTranslations("nav");
  const tAccount = useTranslations("account");
  const tFriends = useTranslations("friends");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const presence = usePresence(open);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function signOut() {
    await forgetThisDevice();
    await postAuth("logout", {});
    setOpen(false);
    router.replace("/login");
    router.refresh();
  }

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-label={t("account")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={triggerClassName}
      >
        <span className="relative flex flex-col short:flex-row items-center gap-1 short:gap-2">
          {trigger ?? <Avatar userId={userId} username={username} avatar={avatar} />}
          {pending > 0 && (
            <span
              title={tFriends("pending", { count: pending })}
              aria-hidden="true"
              className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-accent ring-2 ring-bg"
            />
          )}
        </span>
      </button>
      {presence.mounted && (
        <div
          role="menu"
          data-closing={presence.closing || undefined}
          inert={presence.closing}
          className={`pop-in absolute right-0 z-50 w-56 rounded-ui border border-line bg-surface p-2 shadow-xl shadow-black/40 ${
            variant === "tab" ? "bottom-full mb-3 origin-bottom-right" : "top-full mt-2 origin-top-right"
          }`}
        >
          <p className="px-3 py-2 text-sm text-muted">{t("signedInAs", { name: username })}</p>
          <Link
            href={profileHref(userId)}
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block w-full rounded-ui px-3 py-2 text-left text-sm hover:bg-line active:bg-line pointer-coarse:py-3"
          >
            {t("profile")}
          </Link>
          <Link
            href="/friends"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex w-full items-center justify-between rounded-ui px-3 py-2 text-left text-sm hover:bg-line active:bg-line pointer-coarse:py-3"
          >
            {t("friends")}
            {pending > 0 && <span className="rounded-full bg-accent px-2 text-xs font-bold text-on-accent">{pending}</span>}
          </Link>
          <Link
            href="/room"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block w-full rounded-ui px-3 py-2 text-left text-sm hover:bg-line active:bg-line pointer-coarse:py-3"
          >
            {t("joinRoom")}
          </Link>
          <Link
            href="/settings"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block w-full rounded-ui px-3 py-2 text-left text-sm hover:bg-line active:bg-line pointer-coarse:py-3"
          >
            {tAccount("menuSettings")}
          </Link>
          {isAdmin && (
            <Link
              href="/invites"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block w-full rounded-ui px-3 py-2 text-left text-sm hover:bg-line active:bg-line pointer-coarse:py-3"
            >
              {tAccount("menuInvites")}
            </Link>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={signOut}
            className="w-full rounded-ui px-3 py-2 text-left text-sm hover:bg-line active:bg-line pointer-coarse:py-3"
          >
            {t("signOut")}
          </button>
        </div>
      )}
    </div>
  );
}

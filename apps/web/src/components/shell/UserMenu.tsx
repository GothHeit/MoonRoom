"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Link, useRouter } from "@/i18n/navigation";
import { Avatar } from "@/components/ui/Avatar";
import { BottomSheet } from "@/components/ui/BottomSheet";
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
  /** "tab" is the phone tab bar: a bottom sheet on phones, a popover above the bar on wider screens. */
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
  const presence = usePresence(open && variant === "nav");
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

  const close = () => setOpen(false);
  const itemClass = `flex w-full items-center justify-between rounded-ui px-3 text-left hover:bg-line active:bg-line ${
    variant === "tab" ? "min-h-12 text-base sm:min-h-11 sm:text-sm" : "min-h-11 text-sm"
  }`;
  const items = (
    <>
      <Link href={profileHref(userId)} role="menuitem" onClick={close} className={itemClass}>
        {t("profile")}
      </Link>
      <Link href="/friends" role="menuitem" onClick={close} className={itemClass}>
        {t("friends")}
        {pending > 0 && <span className="rounded-full bg-accent px-2 text-xs font-bold text-on-accent">{pending}</span>}
      </Link>
      <Link href="/room" role="menuitem" onClick={close} className={itemClass}>
        {t("joinRoom")}
      </Link>
      <Link href="/settings" role="menuitem" onClick={close} className={itemClass}>
        {tAccount("menuSettings")}
      </Link>
      {isAdmin && (
        <Link href="/invites" role="menuitem" onClick={close} className={itemClass}>
          {tAccount("menuInvites")}
        </Link>
      )}
      <button type="button" role="menuitem" onClick={signOut} className={itemClass}>
        {t("signOut")}
      </button>
    </>
  );

  return (
    <div ref={root} className={variant === "tab" ? "relative flex w-full" : "relative"}>
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
          className="pop-in absolute right-0 top-full z-50 mt-2 w-56 origin-top-right rounded-ui border border-line bg-surface p-2 shadow-xl shadow-black/40"
        >
          <p className="px-3 py-2 text-sm text-muted">{t("signedInAs", { name: username })}</p>
          {items}
        </div>
      )}
      {open && variant === "tab" && (
        <BottomSheet
          label={t("account")}
          onClose={close}
          scrim
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-2xl border border-line bg-surface pb-[max(0.75rem,env(safe-area-inset-bottom))] text-fg sm:absolute sm:inset-x-auto sm:bottom-full sm:right-2 sm:mb-3 sm:w-56 sm:origin-bottom-right sm:rounded-ui sm:pb-0 sm:shadow-xl sm:shadow-black/40"
        >
          {({ handleProps }) => (
            <>
              <div {...handleProps} className={`px-4 pt-2 sm:px-2 ${handleProps.className}`}>
                <span aria-hidden="true" className="mx-auto mb-3 block h-1 w-10 rounded-full bg-line-strong sm:hidden" />
                <div className="flex items-center gap-3 px-1 pb-3 sm:pb-1">
                  <span className="sm:hidden">
                    <Avatar userId={userId} username={username} avatar={avatar} size={40} />
                  </span>
                  <p className="min-w-0 truncate text-sm font-normal text-muted">{t("signedInAs", { name: username })}</p>
                </div>
              </div>
              <div role="menu" className="min-h-0 overflow-y-auto overscroll-contain border-t border-line px-3 pt-2 font-normal sm:border-0 sm:p-2 sm:pt-0">
                {items}
              </div>
            </>
          )}
        </BottomSheet>
      )}
    </div>
  );
}

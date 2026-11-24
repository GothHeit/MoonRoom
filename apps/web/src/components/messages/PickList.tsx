"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useId, useState } from "react";

import { Avatar } from "@/components/ui/Avatar";
import type { UserSummary } from "@/lib/friends";
import { chatName, type ChatOut } from "@/lib/messages";

import { icons } from "./icons";

export type PickKey = `u:${string}` | `c:${string}`;

type Props = {
  friends: UserSummary[];
  groups?: ChatOut[];
  selected: Set<PickKey>;
  onToggle: (key: PickKey) => void;
  /** Friends who can't be picked (already in the group). */
  disabled?: Set<string>;
};

/** Faces of a group: two avatars, one over the other's corner. */
export function GroupFaces({ members, size = 48 }: { members: UserSummary[]; size?: number }) {
  const [a, b] = members;
  const small = Math.round(size * 0.68);
  if (!a) return <span aria-hidden="true" style={{ width: size, height: size }} className="shrink-0 rounded-full bg-line" />;
  if (!b) return <Avatar userId={a.id} username={a.username} avatar={a.avatar} size={size} />;
  return (
    <span aria-hidden="true" style={{ width: size, height: size }} className="relative shrink-0">
      <Avatar userId={a.id} username={a.username} avatar={a.avatar} size={small} className="absolute left-0 top-0" />
      <Avatar userId={b.id} username={b.username} avatar={b.avatar} size={small} className="absolute bottom-0 right-0 ring-2 ring-[var(--ring,var(--color-bg))]" />
    </span>
  );
}

function Check({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${on ? "border-accent bg-accent text-on-accent" : "border-line-strong"}`}
    >
      {on && icons.check}
    </span>
  );
}

/** Friends (and groups) to tick, with a search box once the list is long enough to need one. */
export function PickList({ friends, groups = [], selected, onToggle, disabled }: Props) {
  const t = useTranslations("messages");
  const format = useFormatter();
  const searchId = useId();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const list = (names: string[]) => format.list(names, { type: "conjunction" });
  const shownFriends = friends.filter((f) => !q || f.username.toLowerCase().includes(q));
  const shownGroups = groups.filter((g) => !q || chatName(g, list).toLowerCase().includes(q));
  const row = "press flex min-h-14 w-full items-center gap-3 px-4 py-1.5 text-left hover:bg-line/40 disabled:opacity-50 sm:px-5";

  return (
    <div className="[--ring:var(--color-surface)]">
      {friends.length + groups.length > 6 && (
        <div className="px-4 pb-1 pt-2 sm:px-5">
          <label htmlFor={searchId} className="sr-only">
            {t("searchFriends")}
          </label>
          <div className="relative text-muted">
            <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2">{icons.search}</span>
            <input
              id={searchId}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("searchFriends")}
              className="min-h-11 w-full rounded-full border border-line-strong bg-bg py-2 pl-11 pr-4 text-base text-fg placeholder:text-muted focus:border-accent [&::-webkit-search-cancel-button]:hidden"
            />
          </div>
        </div>
      )}
      {shownFriends.length > 0 && (
        <>
          <p className="kicker px-4 pb-1 pt-3 sm:px-5">{t("friends")}</p>
          <ul>
            {shownFriends.map((f) => {
              const key: PickKey = `u:${f.id}`;
              const off = disabled?.has(f.id) ?? false;
              const on = off || selected.has(key);
              return (
                <li key={f.id}>
                  <button type="button" role="checkbox" aria-checked={on} disabled={off} onClick={() => onToggle(key)} className={row}>
                    <Avatar userId={f.id} username={f.username} avatar={f.avatar} size={36} />
                    <span className="min-w-0 flex-1 truncate font-medium">{f.username}</span>
                    <Check on={on} />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {shownGroups.length > 0 && (
        <>
          <p className="kicker px-4 pb-1 pt-3 sm:px-5">{t("groups")}</p>
          <ul>
            {shownGroups.map((g) => {
              const key: PickKey = `c:${g.id}`;
              const on = selected.has(key);
              return (
                <li key={g.id}>
                  <button type="button" role="checkbox" aria-checked={on} onClick={() => onToggle(key)} className={row}>
                    <GroupFaces members={g.members} size={36} />
                    <span className="min-w-0 flex-1 truncate font-medium">{chatName(g, list)}</span>
                    <Check on={on} />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {shownFriends.length + shownGroups.length === 0 && <p className="px-4 py-6 text-center text-sm text-muted sm:px-5">{t("noMatches")}</p>}
    </div>
  );
}

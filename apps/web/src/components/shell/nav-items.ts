import type { IconName } from "./Icon";

export type Mode = "anime" | "manga";

type NavItem = { href: string; key: "home" | "browse" | "list"; icon: IconName };

const ANIME_ITEMS: NavItem[] = [
  { href: "/", key: "home", icon: "home" },
  { href: "/browse", key: "browse", icon: "browse" },
  { href: "/list", key: "list", icon: "list" },
];

// My list stays shared until it gets a manga tab.
const MANGA_ITEMS: NavItem[] = [
  { href: "/manga", key: "home", icon: "home" },
  { href: "/manga/browse", key: "browse", icon: "browse" },
  { href: "/list", key: "list", icon: "list" },
];

/** Which catalog a page belongs to. The mode lives in the address, so links and the back button keep it. */
export function modeOf(pathname: string): Mode {
  return pathname === "/manga" || pathname.startsWith("/manga/") || pathname.startsWith("/read/") ? "manga" : "anime";
}

export const navItemsFor = (mode: Mode) => (mode === "manga" ? MANGA_ITEMS : ANIME_ITEMS);

export const searchHrefFor = (mode: Mode) => (mode === "manga" ? "/manga/search" : "/search");

/** The same page in the other catalog's home: the switch always lands somewhere that exists. */
export const modeHome = (mode: Mode) => (mode === "manga" ? "/manga" : "/");

/** True when `pathname` (locale already stripped) is inside the nav item's section. */
export function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  if (href === "/manga") return pathname === "/manga" || pathname.startsWith("/read/");
  return pathname === href || pathname.startsWith(`${href}/`);
}

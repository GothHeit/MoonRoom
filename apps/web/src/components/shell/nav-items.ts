import type { IconName } from "./Icon";

export type Mode = "anime" | "manga";

type NavItem = { href: string; key: "home" | "browse" | "list"; icon: IconName };

const ANIME_ITEMS: NavItem[] = [
  { href: "/", key: "home", icon: "home" },
  { href: "/browse", key: "browse", icon: "browse" },
  { href: "/list", key: "list", icon: "list" },
];

const MANGA_ITEMS: NavItem[] = [
  { href: "/manga", key: "home", icon: "home" },
  { href: "/manga/browse", key: "browse", icon: "browse" },
  { href: "/manga/list", key: "list", icon: "list" },
];

/** Which catalog a page belongs to. The mode lives in the address, so links and the back button keep it. */
export function modeOf(pathname: string): Mode {
  return pathname === "/manga" || pathname.startsWith("/manga/") || pathname.startsWith("/read/") ? "manga" : "anime";
}

export const navItemsFor = (mode: Mode) => (mode === "manga" ? MANGA_ITEMS : ANIME_ITEMS);

export const searchHrefFor = (mode: Mode) => (mode === "manga" ? "/manga/search" : "/search");

const modeHome = (mode: Mode) => (mode === "manga" ? "/manga" : "/");

// Pages that exist in both catalogs, by their anime address.
const COUNTERPARTS: Record<string, string> = { "/": "/manga", "/browse": "/manga/browse", "/list": "/manga/list", "/search": "/manga/search" };

/**
 * Where the catalog switch goes from `pathname` (locale already stripped): the same page in the
 * other catalog when there is one (My list stays My list), else that catalog's home. The query
 * is dropped: a list status or a search is not the same thing on the other side.
 */
export function counterpartOf(pathname: string, mode: Mode): string {
  const section = pathname === "/manga" ? "/" : pathname.startsWith("/manga/") ? pathname.slice("/manga".length) : pathname;
  const entry = Object.entries(COUNTERPARTS).find(([anime, manga]) => section === anime || section === manga);
  if (!entry) return modeHome(mode);
  return mode === "manga" ? entry[1] : entry[0];
}

/** True when `pathname` (locale already stripped) is inside the nav item's section. */
export function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  if (href === "/manga") return pathname === "/manga" || pathname.startsWith("/read/");
  return pathname === href || pathname.startsWith(`${href}/`);
}

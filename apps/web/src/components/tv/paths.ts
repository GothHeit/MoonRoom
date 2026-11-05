/** The TV mode's version of a site address: "/anime/1" -> "/tv/anime/1". */
export const tvHref = (href: string) => `/tv${href === "/" ? "" : href}`;

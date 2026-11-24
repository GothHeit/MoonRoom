/** Messages' icons, on the same 1.8 stroke as the comment icons. */
const svg = "shrink-0";
const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const icons = {
  send: (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={`h-[18px] w-[18px] ${svg}`} {...stroke}>
      <path d="M4 12l16-8-6 17-3-7zM11 14l9-10" />
    </svg>
  ),
  pen: (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={`h-[18px] w-[18px] ${svg}`} {...stroke}>
      <path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" />
    </svg>
  ),
  back: (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={`h-[22px] w-[22px] ${svg}`} {...stroke}>
      <path d="M15 5l-7 7 7 7" />
    </svg>
  ),
  share: (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={`h-[18px] w-[18px] ${svg}`} {...stroke}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M10 9l5 3-5 3z" />
    </svg>
  ),
  muted: (
    // The app's bell, whole, with a slash across it; a mask cuts a gap either side of the slash
    // so it reads on any background.
    <svg aria-hidden="true" viewBox="0 0 24 24" className={`h-4 w-4 ${svg}`} {...stroke}>
      <mask id="bell-off-gap">
        <rect width="24" height="24" fill="white" />
        <path d="M3 3l18 18" stroke="black" strokeWidth="5" />
      </mask>
      <path mask="url(#bell-off-gap)" d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 8H4c0-1 2-2 2-8zM10 21h4" />
      <path d="M3 3l18 18" />
    </svg>
  ),
  play: (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={`h-3.5 w-3.5 ${svg}`} fill="currentColor">
      <path d="M7 4l13 8-13 8z" />
    </svg>
  ),
  book: (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={`h-4 w-4 ${svg}`} {...stroke}>
      <path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 21V5" />
    </svg>
  ),
  check: (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={`h-3.5 w-3.5 ${svg}`} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12l5 5 9-10" />
    </svg>
  ),
  search: (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={`h-[18px] w-[18px] ${svg}`} {...stroke}>
      <path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5" />
    </svg>
  ),
  close: (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={`h-[18px] w-[18px] ${svg}`} {...stroke}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ),
  dots: (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={`h-5 w-5 ${svg}`} fill="currentColor">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  ),
};

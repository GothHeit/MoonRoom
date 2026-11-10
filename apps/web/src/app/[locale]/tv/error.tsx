"use client";

import { TvErrorNotice } from "@/components/tv/TvErrorNotice";

/** A failure outside the shell and the player (the account check, the account picker): full screen. */
export default function TvErrorPage(props: { error: Error; reset: () => void }) {
  return <TvErrorNotice bare {...props} />;
}

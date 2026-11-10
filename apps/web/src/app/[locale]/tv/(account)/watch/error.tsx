"use client";

import { TvErrorNotice } from "@/components/tv/TvErrorNotice";

/** The TV player's page failed to load (the title, the account): full screen, with a retry. */
export default function TvWatchErrorPage(props: { error: Error; reset: () => void }) {
  return <TvErrorNotice bare {...props} />;
}

"use client";

import { TvErrorNotice } from "@/components/tv/TvErrorNotice";

/** The TV room's page failed to load (the account, the server): full screen, with a retry. */
export default function TvRoomErrorPage(props: { error: Error; reset: () => void }) {
  return <TvErrorNotice bare {...props} />;
}

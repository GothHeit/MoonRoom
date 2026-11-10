"use client";

import { TvErrorNotice } from "@/components/tv/TvErrorNotice";

/** A TV screen that failed to load: under the top bar, with a retry the remote can reach. */
export default function TvShellErrorPage(props: { error: Error; reset: () => void }) {
  return <TvErrorNotice {...props} />;
}

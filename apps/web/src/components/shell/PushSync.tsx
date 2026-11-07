"use client";

import { useEffect } from "react";

import { syncPush } from "@/lib/push";

/** Keeps this phone's push registration pointed at whoever is signed in. Renders nothing. */
export function PushSync({ userId }: { userId: string }) {
  useEffect(() => {
    void syncPush(userId);
  }, [userId]);
  return null;
}

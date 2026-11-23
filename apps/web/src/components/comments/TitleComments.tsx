import { Suspense } from "react";

import type { TitleKind } from "@/lib/comments";

import { CommentsLink } from "./CommentsLink";
import { CommentsSection } from "./CommentsSection";
import { firstComments } from "./data";
import { FriendsOnTitle } from "./FriendsOnTitle";

type Props = { kind: TitleKind; id: number; /** Last episode or chapter, to tell "finished it" apart. */ last?: number | null };

/** The comments section at the bottom of a title page, with the friends' progress line on top. */
export async function TitleComments({ kind, id, last }: Props) {
  const page = await firstComments(kind, id);
  return (
    <CommentsSection
      kind={kind}
      id={id}
      initial={page}
      friends={
        <Suspense fallback={null}>
          <FriendsOnTitle kind={kind} id={id} last={last} />
        </Suspense>
      }
    />
  );
}

/** The header's "N comments" link, streamed in on its own so it never holds the header back. */
export async function TitleCommentsLink({ kind, id }: { kind: TitleKind; id: number }) {
  const page = await firstComments(kind, id);
  return <CommentsLink kind={kind} id={id} total={page?.total ?? 0} />;
}

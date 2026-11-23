import type { components } from "@app/api-client";

export type CommentOut = components["schemas"]["CommentOut"];
export type CommentsPage = components["schemas"]["CommentsPage"];
export type FriendWatching = components["schemas"]["FriendWatching"];
export type FriendReading = components["schemas"]["FriendReading"];
export type TitleKind = "anime" | "manga";

export const COMMENT_MAX = 1000;
/** How many comments the title page shows before "Show all". */
export const COMMENTS_FIRST = 3;
export const COMMENTS_PAGE = 50;
export const COMMENTS_ANCHOR = "comments";

/** Fired when the viewer posts or deletes a comment, so the header link can follow the count. */
export const COMMENTS_COUNT_EVENT = "moonroom:comments-count";
export type CommentsCountDetail = { kind: TitleKind; id: number; total: number };

import type { components } from "@app/api-client";

export type ChatOut = components["schemas"]["ChatOut"];
export type MessageOut = components["schemas"]["MessageOut"];
export type ShareOut = components["schemas"]["ShareOut"];
export type ShareIn = components["schemas"]["ShareIn"];

export const MESSAGE_MAX = 2000;
export const GROUP_MAX = 12;
export const SHARE_TARGETS_MAX = 10;
export const MESSAGES_PAGE = 30;

/** Fired when chats are read or new messages arrive, so the Messages icon checks its badge. */
export const UNREAD_EVENT = "moonroom:chats-unread";

export const messagesHref = (chatId?: string) => (chatId ? `/messages/${chatId}` : "/messages");

/** Where a shared card's main button goes: the episode (in whatever source plays it) or the
 * title page. */
export function shareHref(share: ShareOut): string {
  if (share.kind === "manga") return `/manga/${share.id}`;
  return `/continue/${share.id}/${share.episode ?? 1}`;
}

export const detailsHref = (share: ShareOut) => `/${share.kind}/${share.id}`;

/** The chat's name: the group's own, else the other members' names. */
export function chatName(chat: ChatOut, list: (names: string[]) => string): string {
  if (chat.name) return chat.name;
  return list(chat.members.map((m) => m.username)) || "…";
}

/** Two messages closer than this, by the same person, read as one run (one time stamp). */
export const RUN_MS = 5 * 60_000;

export function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

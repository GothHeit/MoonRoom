"use client";

import { errorCode } from "@app/api-client";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { useToast } from "@/components/ui/Toast";
import { api } from "@/lib/api";
import type { CommentOut, CommentsPage, PartComments, ReactionKind, UserSummary } from "@/lib/comments";

type Result<T> = { data?: T; error?: unknown };
type Page = CommentsPage | PartComments;

export type CommentsSource = {
  /** Newest first; `before` is the cursor of the page before. */
  list: (before: string | null, limit: number) => Promise<Result<Page>>;
  create: (text: string, spoiler: boolean) => Promise<Result<CommentOut>>;
};

type Options = {
  source: CommentsSource;
  /** How many to load first, and with each "Show more". */
  first: number;
  page: number;
  /** The first page, loaded with the page; null to load it from here. */
  initial?: Page | null;
  /** Told whenever the number of comments changes. */
  onTotal?: (total: number) => void;
};

/** Applies `change` to the comment or reply with this id, wherever it sits. */
function update(items: CommentOut[], id: string, change: (c: CommentOut) => CommentOut): CommentOut[] {
  return items.map((c) => {
    if (c.id === id) return change(c);
    if (c.replies?.some((r) => r.id === id)) return { ...c, replies: c.replies.map((r) => (r.id === id ? change(r) : r)) };
    return c;
  });
}

/** A list of friends' comments and everything that can be done to it: write, edit, delete,
 * reply and react. Shared by the title page section and the episode and chapter panels. */
export function useComments({ source, first, page, initial, onTotal }: Options) {
  const t = useTranslations("comments");
  const tErr = useTranslations("errors");
  const toast = useToast();
  const [items, setItems] = useState<CommentOut[]>(initial?.items ?? []);
  const [total, setTotalState] = useState(initial?.total ?? 0);
  const [next, setNext] = useState<string | null>(initial?.next ?? null);
  const [locked, setLocked] = useState(initial && "locked" in initial ? initial.locked : false);
  const [people, setPeople] = useState<UserSummary[]>(initial && "people" in initial ? initial.people : []);
  const [state, setState] = useState<"ready" | "loading" | "failed">(initial ? "ready" : "loading");
  const [loadingMore, setLoadingMore] = useState(false);
  // Read through a ref so the callbacks below don't change identity with every render.
  const sourceRef = useRef(source);
  const onTotalRef = useRef(onTotal);
  useEffect(() => {
    sourceRef.current = source;
    onTotalRef.current = onTotal;
  });

  const setTotal = useCallback((count: number) => {
    setTotalState(count);
    onTotalRef.current?.(count);
  }, []);

  const fail = useCallback(
    (error?: unknown) => {
      const code = error === undefined ? "" : errorCode(error);
      toast(code && tErr.has(code) ? tErr(code) : t("actionFailed"), "error");
    },
    [t, tErr, toast],
  );

  const apply = useCallback(
    (data: Page | undefined) => {
      if (!data) return setState("failed");
      setItems(data.items);
      setNext(data.next ?? null);
      setLocked("locked" in data ? data.locked : false);
      setPeople("people" in data ? data.people : []);
      setTotal(data.total);
      setState("ready");
    },
    [setTotal],
  );

  const load = useCallback(() => {
    setState((s) => (s === "failed" ? "loading" : s));
    return sourceRef.current.list(null, first).then(
      ({ data }) => apply(data),
      () => setState("failed"),
    );
  }, [first, apply]);

  // Nothing came with the page: load from here.
  const hadInitial = useRef(!!initial);
  useEffect(() => {
    if (!hadInitial.current) void load();
  }, [load]);

  async function more() {
    if (!next) return;
    setLoadingMore(true);
    try {
      const { data, error } = await sourceRef.current.list(next, page);
      if (!data) return fail(error);
      setItems((current) => [...current, ...data.items.filter((c) => !current.some((o) => o.id === c.id))]);
      setNext(data.next ?? null);
      setTotal(data.total);
    } catch {
      fail();
    } finally {
      setLoadingMore(false);
    }
  }

  async function post(text: string, spoiler: boolean) {
    try {
      const { data, error } = await sourceRef.current.create(text, spoiler);
      if (!data) {
        fail(error);
        return false;
      }
      setItems((current) => [data, ...current]);
      setTotal(total + 1);
      return true;
    } catch {
      fail();
      return false;
    }
  }

  async function save(comment: CommentOut, text: string, spoiler: boolean) {
    try {
      const { data, error } = await api.PATCH("/comments/{comment_id}", {
        params: { path: { comment_id: comment.id } },
        body: { body: text, spoiler },
      });
      if (!data) {
        fail(error);
        return false;
      }
      setItems((current) => update(current, data.id, (old) => ({ ...data, replies: old.replies })));
      return true;
    } catch {
      fail();
      return false;
    }
  }

  async function remove(comment: CommentOut) {
    try {
      const { error, response } = await api.DELETE("/comments/{comment_id}", { params: { path: { comment_id: comment.id } } });
      if (!response.ok && response.status !== 404) {
        fail(error);
        return false;
      }
      const topLevel = items.some((c) => c.id === comment.id);
      setItems((current) =>
        topLevel ? current.filter((c) => c.id !== comment.id) : current.map((c) => ({ ...c, replies: (c.replies ?? []).filter((r) => r.id !== comment.id) })),
      );
      if (topLevel) setTotal(Math.max(0, total - 1));
      toast(t("deleted"), "success");
      return true;
    } catch {
      fail();
      return false;
    }
  }

  async function reply(parent: CommentOut, text: string) {
    try {
      const { data, error } = await api.POST("/comments/{comment_id}/replies", {
        params: { path: { comment_id: parent.id } },
        body: { body: text },
      });
      if (!data) {
        fail(error);
        return false;
      }
      setItems((current) => update(current, parent.id, (c) => ({ ...c, replies: [...(c.replies ?? []), data] })));
      return true;
    } catch {
      fail();
      return false;
    }
  }

  async function react(comment: CommentOut, kind: ReactionKind) {
    const mine = comment.reactions?.some((r) => r.kind === kind && r.mine) ?? false;
    const path = { params: { path: { comment_id: comment.id, kind } } };
    try {
      const { data, error } = mine ? await api.DELETE("/comments/{comment_id}/reactions/{kind}", path) : await api.PUT("/comments/{comment_id}/reactions/{kind}", path);
      if (!data) return fail(error);
      setItems((current) => update(current, comment.id, (c) => ({ ...c, reactions: data })));
    } catch {
      fail();
    }
  }

  return { items, total, next, locked, people, state, loadingMore, load, more, post, save, remove, reply, react };
}

export type CommentsState = ReturnType<typeof useComments>;

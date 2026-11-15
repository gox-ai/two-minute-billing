"use client";

import * as React from "react";
import type { ItemQuery, TransferItemPage } from "@/lib/api/transfer";
import { ITEM_PAGE, itemQueryKey, reloadLimit } from "@/lib/transfer-items";

export type ListItemsAction = (
  biz: string,
  run: string,
  query: ItemQuery,
) => Promise<TransferItemPage | null>;

/** A first page the server already loaded, for the query it answers. */
export interface InitialPage {
  query: ItemQuery;
  page: TransferItemPage;
}

/**
 * Pages of a run's items for one query. A new query starts over; a new `token` (the run
 * changed: an item left out, a poll) reloads the items shown so far. `enabled: false`
 * holds an empty list and fetches nothing.
 */
export function useItemPages({
  biz,
  run,
  query,
  token,
  listItems,
  initial,
  enabled = true,
}: {
  biz: string;
  run: string;
  query: ItemQuery;
  token: string;
  listItems: ListItemsAction;
  initial?: InitialPage | null;
  enabled?: boolean;
}) {
  const key = itemQueryKey(query);
  const seeded = initial && itemQueryKey(initial.query) === key ? initial.page : null;
  const [state, setState] = React.useState(() => ({
    key: seeded ? key : "",
    items: seeded?.data ?? [],
    cursor: seeded?.has_more ? seeded.next_cursor : null,
  }));
  const [loading, setLoading] = React.useState(!seeded && enabled);
  const [failed, setFailed] = React.useState(false);
  const stateRef = React.useRef(state);
  const queryRef = React.useRef(query);
  const req = React.useRef(0);
  const loaded = React.useRef(seeded ? `${key}|${token}` : "");
  // Declared before the fetch effect, so it reads this render's values.
  React.useEffect(() => {
    stateRef.current = state;
    queryRef.current = query;
  });

  React.useEffect(() => {
    if (!enabled) {
      loaded.current = "";
      return;
    }
    const want = `${key}|${token}`;
    if (loaded.current === want) return;
    loaded.current = want;
    const same = stateRef.current.key === key;
    const id = ++req.current;
    setLoading(true);
    listItems(biz, run, {
      ...queryRef.current,
      limit:
        queryRef.current.limit ?? (same ? reloadLimit(stateRef.current.items.length) : ITEM_PAGE),
    }).then((page) => {
      if (id !== req.current) return;
      setLoading(false);
      setFailed(!page);
      if (!page) return;
      setState({ key, items: page.data, cursor: page.has_more ? page.next_cursor : null });
    });
  }, [biz, run, key, token, enabled, listItems]);

  const more = React.useCallback(async () => {
    const { cursor, key: k } = stateRef.current;
    if (!cursor) return;
    const id = ++req.current;
    setLoading(true);
    const page = await listItems(biz, run, {
      ...queryRef.current,
      limit: ITEM_PAGE,
      starting_after: cursor,
    });
    if (id !== req.current) return;
    setLoading(false);
    setFailed(!page);
    if (!page) return;
    setState((s) =>
      s.key === k
        ? {
            key: k,
            items: [...s.items, ...page.data],
            cursor: page.has_more ? page.next_cursor : null,
          }
        : s,
    );
  }, [biz, run, listItems]);

  return {
    /** Empty while a new query loads, so an old list never shows under a new filter. */
    items: enabled && state.key === key ? state.items : [],
    hasMore: enabled && state.key === key && !!state.cursor,
    loading,
    failed,
    more,
  };
}

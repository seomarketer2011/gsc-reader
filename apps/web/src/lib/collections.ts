"use client";

// User-state collections (saved filters, dismissed opportunities, rollout
// drafts). Signed in with Supabase configured → rows in Postgres, protected
// by RLS. Otherwise → the Phase 1 localStorage behaviour, unchanged.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppState } from "@/components/AppStateProvider";
import { getBrowserClient } from "@/lib/supabase/client";
import { Rollout, SavedFilter } from "@/lib/types";
import { useLocalList } from "@/lib/useLocalList";

export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

interface CollectionConfig<T> {
  localKey: string;
  table: string;
  idColumn: string;
  getId: (item: T) => string;
  toRow: (item: T, ctx: { orgId: string; userId: string }) => Record<string, unknown>;
  fromRow: (row: Record<string, unknown>) => T;
}

export interface Collection<T> {
  items: T[];
  add: (item: T) => void;
  remove: (id: string) => void;
  clear: () => void;
  ready: boolean;
}

function useSyncedCollection<T>(config: CollectionConfig<T>): Collection<T> {
  const { configured, userId, orgId } = useAppState();
  const remote = Boolean(configured && userId && orgId);

  const [local, setLocal, localReady] = useLocalList<T[]>(config.localKey, []);
  const [remoteItems, setRemoteItems] = useState<T[]>([]);
  const [remoteReady, setRemoteReady] = useState(false);

  useEffect(() => {
    if (!remote || !userId) return;
    let cancelled = false;
    getBrowserClient()!
      .from(config.table)
      .select("*")
      .eq("user_id", userId)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) console.warn(`load ${config.table} failed:`, error.message);
        else setRemoteItems((data ?? []).map(config.fromRow));
        setRemoteReady(true);
      });
    return () => {
      cancelled = true;
    };
    // config objects are module-level constants
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote, userId]);

  const add = useCallback(
    (item: T) => {
      if (remote && userId && orgId) {
        setRemoteItems((prev) => [...prev.filter((x) => config.getId(x) !== config.getId(item)), item]);
        getBrowserClient()!
          .from(config.table)
          .upsert(config.toRow(item, { orgId, userId }))
          .then(({ error }) => {
            if (error) console.warn(`save to ${config.table} failed:`, error.message);
          });
      } else {
        setLocal([...local.filter((x) => config.getId(x) !== config.getId(item)), item]);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [remote, userId, orgId, local, setLocal],
  );

  const remove = useCallback(
    (id: string) => {
      if (remote && userId) {
        setRemoteItems((prev) => prev.filter((x) => config.getId(x) !== id));
        getBrowserClient()!
          .from(config.table)
          .delete()
          .eq(config.idColumn, id)
          .eq("user_id", userId)
          .then(({ error }) => {
            if (error) console.warn(`delete from ${config.table} failed:`, error.message);
          });
      } else {
        setLocal(local.filter((x) => config.getId(x) !== id));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [remote, userId, local, setLocal],
  );

  const clear = useCallback(() => {
    if (remote && userId) {
      setRemoteItems([]);
      getBrowserClient()!
        .from(config.table)
        .delete()
        .eq("user_id", userId)
        .then(({ error }) => {
          if (error) console.warn(`clear ${config.table} failed:`, error.message);
        });
    } else {
      setLocal([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote, userId, setLocal]);

  return useMemo(
    () => ({
      items: remote ? remoteItems : local,
      add,
      remove,
      clear,
      ready: remote ? remoteReady : localReady,
    }),
    [remote, remoteItems, local, add, remove, clear, remoteReady, localReady],
  );
}

// ── Concrete collections ─────────────────────────────────────────────────

const SAVED_FILTERS: CollectionConfig<SavedFilter> = {
  localKey: "saved-filters",
  table: "saved_filters",
  idColumn: "id",
  getId: (f) => f.id,
  toRow: (f, ctx) => ({
    id: f.id,
    organisation_id: ctx.orgId,
    user_id: ctx.userId,
    name: f.name,
    params: f.params,
  }),
  fromRow: (r) => ({ id: String(r.id), name: String(r.name), params: String(r.params) }),
};

export function useSavedFilters(): Collection<SavedFilter> {
  return useSyncedCollection(SAVED_FILTERS);
}

interface Dismissal {
  id: string; // opportunity key, e.g. "opp-12"
}

const DISMISSALS: CollectionConfig<Dismissal> = {
  localKey: "dismissed-opportunities-v2",
  table: "user_dismissals",
  idColumn: "opportunity_key",
  getId: (d) => d.id,
  toRow: (d, ctx) => ({
    organisation_id: ctx.orgId,
    user_id: ctx.userId,
    opportunity_key: d.id,
  }),
  fromRow: (r) => ({ id: String(r.opportunity_key) }),
};

export function useDismissals(): Collection<Dismissal> {
  return useSyncedCollection(DISMISSALS);
}

const ROLLOUTS: CollectionConfig<Rollout> = {
  localKey: "rollouts",
  table: "rollouts",
  idColumn: "id",
  getId: (r) => r.id,
  toRow: (r, ctx) => ({
    id: r.id,
    organisation_id: ctx.orgId,
    opportunity_key: r.opportunityId,
    blueprint_title: r.blueprintTitle,
    batches: r.batches,
    excluded_site_ids: r.excludedSiteIds,
    review_site_ids: r.reviewSiteIds,
    status: r.status,
    created_by: ctx.userId,
    created_at: r.createdAt,
  }),
  fromRow: (r) => ({
    id: String(r.id),
    opportunityId: String(r.opportunity_key ?? ""),
    blueprintTitle: String(r.blueprint_title),
    batches: (r.batches ?? []) as Rollout["batches"],
    excludedSiteIds: (r.excluded_site_ids ?? []) as string[],
    reviewSiteIds: (r.review_site_ids ?? []) as string[],
    createdAt: String(r.created_at),
    status: (r.status === "in_progress" ? "in_progress" : "draft") as Rollout["status"],
  }),
};

export function useRollouts(): Collection<Rollout> {
  return useSyncedCollection(ROLLOUTS);
}

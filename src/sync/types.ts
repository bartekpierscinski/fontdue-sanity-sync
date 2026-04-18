import type { SanityClient } from "@sanity/client";

export type SyncTrigger = "manual" | "webhook" | "cron";

export interface SyncOptions {
  sanityClient: SanityClient;
  fontdueUrl: string;
  onProgress?: (stage: string, current: number, total: number) => void;
  /** Number of documents to batch in a single transaction (default: 50) */
  batchSize?: number;
  /** What triggered this sync (default: "manual") */
  triggeredBy?: SyncTrigger;
  /** Preview changes without applying (default: false) */
  dryRun?: boolean;
  /** Sync parent references on collections for bidirectional relationships (default: false) */
  includeParentRef?: boolean;
  /** Sync family references on styles for bidirectional relationships (default: false) */
  includeFamilyRef?: boolean;
  /** Write updatedAt field on collection documents (default: false) */
  includeUpdatedAt?: boolean;
  /** Write a fontdueSyncStatus document after sync (default: true) */
  storeSyncStatus?: boolean;
}

export interface SyncStats {
  created: number;
  updated: number;
  deleted: number;
  skippedUnchanged: number;
}

export interface SyncResult {
  collections: SyncStats;
  styles: SyncStats;
  licenses: SyncStats;
  /** Duration of the sync in milliseconds */
  durationMs: number;
  /** What triggered this sync */
  triggeredBy: SyncTrigger;
  /** Whether the sync completed successfully */
  status: "success" | "failed";
  /** Error message if sync failed */
  errorMessage?: string;
}

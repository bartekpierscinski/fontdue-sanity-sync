import type { SanityClient } from "@sanity/client";

export type SyncTrigger = "manual" | "webhook" | "cron";

/**
 * What happens to a synced document that is no longer in Fontdue's public
 * API (deleted, or hidden).
 *
 * - `"delete"`: strip every reference to it across the dataset and delete it.
 * - `"softDelete"`: a collection or pack that another document still
 *   references is kept and marked `isDeleted` / `deletedAt`, references
 *   intact; one nothing references is deleted. Styles and licenses are
 *   always deleted. Declare the fields with `includeSoftDelete: true` on the
 *   schema side.
 */
export type OrphanStrategy = "delete" | "softDelete";

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
  /** Write dateModified and versionString on style documents (default: false) */
  includeStyleFontMetadata?: boolean;
  /** Write featureStyle reference on collection documents (default: false) */
  includeFeatureStyleRef?: boolean;
  /** Write a fontdueSyncStatus document after sync (default: true) */
  storeSyncStatus?: boolean;
  /**
   * Mirror font packs as `fontduePack` documents (default: false). Needs
   * `includePacks: true` on the schema side. A backend without font packs,
   * or a failed pack request, leaves existing pack documents untouched and
   * reports the reason in `packsSkipped`.
   */
  syncPacks?: boolean;
  /** How documents that left Fontdue are handled (default: "delete") */
  orphanStrategy?: OrphanStrategy;
  /**
   * Allow a run in which Fontdue returns no collections while Sanity still
   * holds some (default: false). Off, such a run aborts before writing
   * anything, since it would otherwise delete or unlink every synced
   * document because of one bad response.
   */
  allowEmptyCatalog?: boolean;
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
  /** Present only when `syncPacks` ran */
  packs?: SyncStats;
  /** Why `syncPacks` was requested but left pack documents untouched */
  packsSkipped?: string;
  /** Duration of the sync in milliseconds */
  durationMs: number;
  /** What triggered this sync */
  triggeredBy: SyncTrigger;
  /** Whether the sync completed successfully */
  status: "success" | "failed";
  /** Error message if sync failed */
  errorMessage?: string;
}

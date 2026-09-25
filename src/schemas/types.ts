import type { ComponentType } from "react";

export interface SchemaOptions {
  /** Custom icons for document types in Sanity Studio */
  icons?: {
    collection?: ComponentType;
    superfamily?: ComponentType;
    style?: ComponentType;
    license?: ComponentType;
    pack?: ComponentType;
  };
  /** Add parent reference on collections for bidirectional relationships (default: false) */
  includeParentRef?: boolean;
  /** Add family reference on styles for bidirectional relationships (default: false) */
  includeFamilyRef?: boolean;
  /** Add updatedAt field on collections for change tracking (default: false) */
  includeUpdatedAt?: boolean;
  /** Add dateModified + versionString fields on fontdueStyle (default: false) */
  includeStyleFontMetadata?: boolean;
  /** Add featureStyle reference on fontdueCollection (default: false) */
  includeFeatureStyleRef?: boolean;
  /**
   * Register the `fontduePack` document type (default: false).
   * Pair with `syncPacks: true` in `syncFontdueData`.
   */
  includePacks?: boolean;
  /**
   * Declare the `isDeleted` / `deletedAt` fields on collections and packs
   * (default: false). Written by `syncFontdueData` when `orphanStrategy` is
   * `"softDelete"`; without them the Studio flags soft-deleted documents as
   * carrying unknown fields.
   */
  includeSoftDelete?: boolean;
}

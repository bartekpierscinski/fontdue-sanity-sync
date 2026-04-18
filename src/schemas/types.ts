import type { ComponentType } from "react";

export interface SchemaOptions {
  /** Custom icons for document types in Sanity Studio */
  icons?: {
    collection?: ComponentType;
    superfamily?: ComponentType;
    style?: ComponentType;
    license?: ComponentType;
  };
  /** Add parent reference on collections for bidirectional relationships (default: false) */
  includeParentRef?: boolean;
  /** Add family reference on styles for bidirectional relationships (default: false) */
  includeFamilyRef?: boolean;
  /** Add updatedAt field on collections for change tracking (default: false) */
  includeUpdatedAt?: boolean;
}

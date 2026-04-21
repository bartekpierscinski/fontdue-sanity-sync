# Generic Orphan Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace manual reference-type config and soft-delete with generic `references()` based cleanup that handles all document types automatically.

**Architecture:** Use Sanity's `references()` GROQ function to find all documents referencing orphaned IDs, fetch them, walk their fields to find matching `_ref` values, build unset/filter patches, then hard-delete everything. Remove `referenceTypes`, `referenceField`, and `includeSoftDelete` options entirely.

**Tech Stack:** TypeScript, Sanity Client, GROQ

---

### Task 1: Remove soft-delete from schema

**Files:**
- Modify: `src/schemas/types.ts`
- Modify: `src/schemas/fontdueCollection.ts`

- [ ] **Step 1: Remove `includeSoftDelete` from `SchemaOptions`**

In `src/schemas/types.ts`, remove the `includeSoftDelete` property:

```typescript
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
```

- [ ] **Step 2: Remove soft-delete fields and logic from `fontdueCollection.ts`**

Remove the `includeSoftDelete` variable, the `isDeleted`/`deletedAt` field definitions, and the soft-delete preview logic. The full updated file:

```typescript
import { defineField, defineType } from "sanity";
import type { SchemaOptions } from "./types.js";

export function createFontdueCollection(options?: SchemaOptions) {
  const includeParentRef = options?.includeParentRef === true;
  const includeUpdatedAt = options?.includeUpdatedAt === true;
  const collectionIcon = options?.icons?.collection;
  const superfamilyIcon = options?.icons?.superfamily;

  const fields = [
    defineField({
      name: "fontdueId",
      title: "Fontdue ID",
      type: "string",
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: "name",
      title: "Name",
      type: "string",
    }),
    defineField({
      name: "slug",
      title: "Slug",
      type: "string",
    }),
    defineField({
      name: "collectionType",
      title: "Collection Type",
      type: "string",
      options: {
        list: [
          { title: "Family", value: "family" },
          { title: "Superfamily", value: "superfamily" },
        ],
      },
    }),
    ...(includeParentRef
      ? [
          defineField({
            name: "parent",
            title: "Parent Collection",
            type: "reference",
            to: [{ type: "fontdueCollection" }],
            description:
              "Superfamily parent (for families that are part of a superfamily)",
          }),
        ]
      : []),
    defineField({
      name: "children",
      title: "Child Collections",
      description: includeParentRef
        ? "Families within this superfamily (computed reverse reference)"
        : "Families within this superfamily",
      type: "array",
      of: [{ type: "reference", to: [{ type: "fontdueCollection" }] }],
      hidden: ({ document }) => document?.collectionType !== "superfamily",
    }),
    defineField({
      name: "styles",
      title: "Styles",
      description: "Font styles in this family",
      type: "array",
      of: [{ type: "reference", to: [{ type: "fontdueStyle" }] }],
      hidden: ({ document }) => document?.collectionType !== "family",
    }),
    ...(includeUpdatedAt
      ? [
          defineField({
            name: "updatedAt",
            title: "Updated At",
            type: "datetime",
            hidden: true,
          }),
        ]
      : []),
  ];

  return defineType({
    name: "fontdueCollection",
    title: "Font",
    type: "document",
    readOnly: true,
    fields,
    preview: {
      select: {
        title: "name",
        collectionType: "collectionType",
        ...(includeParentRef ? { parentName: "parent.name" } : {}),
      },
      prepare(selection) {
        const { title, collectionType } = selection;
        const parentName =
          "parentName" in selection ? selection.parentName : undefined;

        let subtitle = collectionType;
        if (parentName) {
          subtitle = `${collectionType} in ${parentName}`;
        }

        const icon =
          collectionType === "superfamily" ? superfamilyIcon : collectionIcon;

        return {
          title,
          subtitle,
          ...(icon ? { media: icon } : {}),
        };
      },
    },
  });
}
```

- [ ] **Step 3: Build and verify no type errors**

Run: `cd /Users/bartek14/Documents/WORK/FONTDUE/_packages/sanity-fontdue && npm run typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/schemas/types.ts src/schemas/fontdueCollection.ts
git commit -m "refactor: remove soft-delete from schema options and collection fields"
```

---

### Task 2: Remove `referenceTypes` and `referenceField` from sync types

**Files:**
- Modify: `src/sync/types.ts`

- [ ] **Step 1: Remove the two options from `SyncOptions`**

Updated `src/sync/types.ts`:

```typescript
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
```

- [ ] **Step 2: Commit**

```bash
git add src/sync/types.ts
git commit -m "refactor: remove referenceTypes and referenceField from SyncOptions"
```

---

### Task 3: Add generic reference cleanup helper

**Files:**
- Create: `src/sync/cleanupReferences.ts`

- [ ] **Step 1: Create the helper**

This function finds all external documents referencing any of the orphaned IDs, walks their fields to find `_ref` matches, and builds patches to remove them.

```typescript
import type { SanityClient } from "@sanity/client";
import { chunk } from "./utils.js";

interface ReferenceCleanup {
  id: string;
  unsetPaths: string[];
  arrayFilters: { path: string; idsToRemove: string[] }[];
}

/**
 * Find all documents referencing any of the given IDs and build patches
 * to remove those references. Handles both direct reference fields
 * (unset the field) and array reference items (filter them out).
 */
export async function cleanupExternalReferences({
  sanityClient,
  orphanedIds,
  excludeTypes,
  batchSize = 50,
  onProgress,
}: {
  sanityClient: SanityClient;
  orphanedIds: string[];
  excludeTypes: string[];
  batchSize?: number;
  onProgress?: (stage: string, current: number, total: number) => void;
}): Promise<number> {
  if (orphanedIds.length === 0) return 0;

  const progress = onProgress || (() => {});
  const orphanedSet = new Set(orphanedIds);
  const typeFilter = excludeTypes.map((t) => `"${t}"`).join(", ");

  // Find all external documents that reference any orphaned ID
  progress("Finding external references", 0, 1);
  const referencingDocs = await sanityClient.fetch<any[]>(
    `*[references($ids) && !(_type in [${typeFilter}])]{...}`,
    { ids: orphanedIds },
  );
  progress("Finding external references", 1, 1);

  if (referencingDocs.length === 0) return 0;

  // For each referencing doc, find which fields contain orphaned refs
  const cleanups: { docId: string; patches: Record<string, unknown> }[] = [];

  for (const doc of referencingDocs) {
    const unsetPaths: string[] = [];
    const arrayPatches: Record<string, unknown[]> = {};

    walkFields(doc, "", orphanedSet, unsetPaths, arrayPatches);

    if (unsetPaths.length > 0 || Object.keys(arrayPatches).length > 0) {
      cleanups.push({
        docId: doc._id,
        patches: { unsetPaths, arrayPatches },
      });
    }
  }

  if (cleanups.length === 0) return 0;

  // Apply patches in batches
  const cleanupBatches = chunk(cleanups, batchSize);
  let processed = 0;
  let totalCleaned = 0;

  for (const batch of cleanupBatches) {
    progress("Cleaning external references", processed, cleanups.length);
    const transaction = sanityClient.transaction();

    for (const { docId, patches } of batch) {
      const { unsetPaths, arrayPatches } = patches as {
        unsetPaths: string[];
        arrayPatches: Record<string, unknown[]>;
      };

      let patch = transaction.patch(docId);

      if (unsetPaths.length > 0) {
        patch = patch.unset(unsetPaths);
        totalCleaned += unsetPaths.length;
      }

      for (const [path, filtered] of Object.entries(arrayPatches)) {
        patch = patch.set({ [path]: filtered });
        totalCleaned++;
      }
    }

    await transaction.commit({ visibility: "sync" });
    processed += batch.length;
  }

  progress("Cleaning external references", cleanups.length, cleanups.length);
  return totalCleaned;
}

/**
 * Recursively walk document fields to find references to orphaned IDs.
 * - Direct reference fields ({ _ref: "orphaned-id" }) -> add to unsetPaths
 * - Array items with orphaned _ref -> add filtered array to arrayPatches
 */
function walkFields(
  obj: Record<string, unknown>,
  basePath: string,
  orphanedSet: Set<string>,
  unsetPaths: string[],
  arrayPatches: Record<string, unknown[]>,
): void {
  for (const [key, value] of Object.entries(obj)) {
    // Skip internal Sanity fields
    if (key.startsWith("_") && key !== "_ref") continue;

    const currentPath = basePath ? `${basePath}.${key}` : key;

    if (Array.isArray(value)) {
      // Check if this array contains reference objects with orphaned _refs
      const hasOrphanedRefs = value.some(
        (item) =>
          item &&
          typeof item === "object" &&
          "_ref" in item &&
          orphanedSet.has((item as { _ref: string })._ref),
      );

      if (hasOrphanedRefs) {
        const filtered = value.filter(
          (item) =>
            !(
              item &&
              typeof item === "object" &&
              "_ref" in item &&
              orphanedSet.has((item as { _ref: string })._ref)
            ),
        );
        arrayPatches[currentPath] = filtered;
      }
    } else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if ("_ref" in record && orphanedSet.has(record._ref as string)) {
        // Direct reference field pointing to an orphaned doc
        unsetPaths.push(currentPath);
      } else {
        // Recurse into nested objects
        walkFields(record, currentPath, orphanedSet, unsetPaths, arrayPatches);
      }
    }
  }
}
```

- [ ] **Step 2: Export from sync index**

In `src/sync/index.ts`, add the export:

```typescript
export { syncFontdueData } from "./syncFontdueData.js";
export { cleanupExternalReferences } from "./cleanupReferences.js";
```

- [ ] **Step 3: Build and verify no type errors**

Run: `cd /Users/bartek14/Documents/WORK/FONTDUE/_packages/sanity-fontdue && npm run typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/sync/cleanupReferences.ts src/sync/index.ts
git commit -m "feat: add generic reference cleanup helper using references() GROQ function"
```

---

### Task 4: Rewrite Phase 7 in syncFontdueData

**Files:**
- Modify: `src/sync/syncFontdueData.ts`

- [ ] **Step 1: Add import for cleanupExternalReferences**

At top of `src/sync/syncFontdueData.ts`, add:

```typescript
import { cleanupExternalReferences } from "./cleanupReferences.js";
```

- [ ] **Step 2: Remove `referenceTypes` and `referenceField` from destructuring**

Change the function signature destructuring (around line 62) from:

```typescript
export async function syncFontdueData({
  sanityClient,
  fontdueUrl,
  onProgress,
  batchSize = 50,
  triggeredBy = "manual",
  dryRun = false,
  referenceTypes,
  referenceField = "fontdueCollection._ref",
  includeParentRef = false,
  includeFamilyRef = false,
  storeSyncStatus = true,
}: SyncOptions): Promise<SyncResult> {
```

to:

```typescript
export async function syncFontdueData({
  sanityClient,
  fontdueUrl,
  onProgress,
  batchSize = 50,
  triggeredBy = "manual",
  dryRun = false,
  includeParentRef = false,
  includeFamilyRef = false,
  storeSyncStatus = true,
}: SyncOptions): Promise<SyncResult> {
```

- [ ] **Step 3: Remove `isDeleted` from collection change detection**

In Phase 3, the change detection check (around line 172) includes `existing.isDeleted === true` as a reason to re-sync. Remove that condition:

Change:

```typescript
      if (
        existing.fontdueId !== doc.fontdueId ||
        existing.name !== doc.name ||
        existing.slug !== doc.slug ||
        existing.collectionType !== doc.collectionType ||
        existing.isDeleted === true
      ) {
```

to:

```typescript
      if (
        existing.fontdueId !== doc.fontdueId ||
        existing.name !== doc.name ||
        existing.slug !== doc.slug ||
        existing.collectionType !== doc.collectionType
      ) {
```

Also remove `isDeleted` from the Phase 2 collection fetch query (around line 101):

Change:

```typescript
      sanityClient.fetch<any[]>(
        `*[_type == "fontdueCollection"]{ _id, fontdueId, name, slug, collectionType, children, styles, updatedAt, isDeleted }`,
      ),
```

to:

```typescript
      sanityClient.fetch<any[]>(
        `*[_type == "fontdueCollection"]{ _id, fontdueId, name, slug, collectionType, children, styles, updatedAt }`,
      ),
```

- [ ] **Step 4: Replace entire Phase 7 (orphan handling)**

Replace everything from `// --- Phase 7: Handle orphaned documents ---` up to (but not including) `// --- Phase 8: Save sync status ---` with:

```typescript
  // --- Phase 7: Handle orphaned documents ---
  const orphanedStyleIds = Array.from(existingStylesMap.keys()).filter(
    (id) => !syncedStyleIds.has(id),
  );
  const orphanedCollectionIds = Array.from(
    existingCollectionsMap.keys(),
  ).filter((id) => !syncedCollectionIds.has(id));
  const orphanedLicenseIds = Array.from(existingLicensesMap.keys()).filter(
    (id) => !syncedLicenseIds.has(id),
  );

  stats.styles.deleted = orphanedStyleIds.length;
  stats.collections.deleted = orphanedCollectionIds.length;
  stats.licenses.deleted = orphanedLicenseIds.length;

  const allOrphanedIds = [
    ...orphanedStyleIds,
    ...orphanedCollectionIds,
    ...orphanedLicenseIds,
  ];

  if (!dryRun && allOrphanedIds.length > 0) {
    // Step 1: Clean internal references (fontdueCollection.styles[] and .children[])
    const orphanedStyleSet = new Set(orphanedStyleIds);
    const orphanedCollectionSet = new Set(orphanedCollectionIds);

    const currentCollections = await sanityClient.fetch<any[]>(
      `*[_type == "fontdueCollection"]{ _id, children, styles }`,
    );

    const internalCleanups: {
      sanityId: string;
      patch: Record<string, unknown>;
    }[] = [];

    for (const existing of currentCollections) {
      const patchFields: Record<string, unknown> = {};

      if (existing.styles?.length) {
        const filtered = existing.styles.filter(
          (s: { _ref: string }) => !orphanedStyleSet.has(s._ref),
        );
        if (filtered.length !== existing.styles.length) {
          patchFields.styles = filtered;
        }
      }

      if (existing.children?.length) {
        const filtered = existing.children.filter(
          (c: { _ref: string }) => !orphanedCollectionSet.has(c._ref),
        );
        if (filtered.length !== existing.children.length) {
          patchFields.children = filtered;
        }
      }

      if (Object.keys(patchFields).length > 0) {
        internalCleanups.push({ sanityId: existing._id, patch: patchFields });
      }
    }

    if (internalCleanups.length > 0) {
      const cleanupBatches = chunk(internalCleanups, batchSize);
      let processed = 0;
      for (const batch of cleanupBatches) {
        progress(
          "Removing internal references",
          processed,
          internalCleanups.length,
        );
        const transaction = sanityClient.transaction();
        for (const { sanityId, patch } of batch) {
          transaction.patch(sanityId, (p) => p.set(patch));
        }
        await transaction.commit({ visibility: "sync" });
        processed += batch.length;
      }
      progress(
        "Removing internal references",
        internalCleanups.length,
        internalCleanups.length,
      );
    }

    // Step 2: Clean external references (any doc type referencing orphaned IDs)
    await cleanupExternalReferences({
      sanityClient,
      orphanedIds: allOrphanedIds,
      excludeTypes: [
        "fontdueCollection",
        "fontdueStyle",
        "fontdueLicense",
        "fontdueSyncStatus",
      ],
      batchSize,
      onProgress: progress,
    });

    // Step 3: Hard-delete all orphaned documents
    const deleteBatches = chunk(allOrphanedIds, batchSize);
    let processed = 0;
    for (const batch of deleteBatches) {
      progress(
        "Deleting orphaned documents",
        processed,
        allOrphanedIds.length,
      );
      const transaction = sanityClient.transaction();
      for (const id of batch) {
        transaction.delete(id);
      }
      await transaction.commit({ visibility: "async" });
      processed += batch.length;
    }
    progress(
      "Deleting orphaned documents",
      allOrphanedIds.length,
      allOrphanedIds.length,
    );
  }
```

- [ ] **Step 5: Build and verify no type errors**

Run: `cd /Users/bartek14/Documents/WORK/FONTDUE/_packages/sanity-fontdue && npm run typecheck`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/sync/syncFontdueData.ts
git commit -m "feat: replace referenceTypes/soft-delete with generic references() cleanup

All orphaned documents now get external references cleaned via
Sanity's references() function before hard deletion. This handles
any document type (typeface, typefacePage, etc.) referencing fontdue
docs without requiring manual configuration."
```

---

### Task 5: Update consumer projects

**Files:**
- Modify: `monokrom/studio/scripts/fontdue/sync-fontdue.ts`
- Modify: `latinotype/apps/studio/scripts/sync-fontdue.ts`
- Modify: `latinotype/apps/web/src/app/api/sync/route.ts`

- [ ] **Step 1: Update Monokrom sync script**

In `/Users/bartek14/Documents/WORK/FONTDUE/monokrom/studio/scripts/fontdue/sync-fontdue.ts`, remove `referenceTypes: ["typeface"],` from the `syncFontdueData` call (around line 119):

Change:

```typescript
  const result = await syncFontdueData({
    sanityClient: client,
    fontdueUrl: fontdueUrl!,
    dryRun,
    referenceTypes: ["typeface"],
    onProgress: (stage, current, total) => {
```

to:

```typescript
  const result = await syncFontdueData({
    sanityClient: client,
    fontdueUrl: fontdueUrl!,
    dryRun,
    onProgress: (stage, current, total) => {
```

- [ ] **Step 2: Update Latinotype sync script**

In `/Users/bartek14/Documents/WORK/FONTDUE/latinotype/apps/studio/scripts/sync-fontdue.ts`, remove `referenceTypes: ["typefacePage"],` from the `syncFontdueData` call (around line 119):

Change:

```typescript
  const result = await syncFontdueData({
    sanityClient: client,
    fontdueUrl: fontdueUrl!,
    dryRun,
    referenceTypes: ["typefacePage"],
    onProgress: (stage, current, total) => {
```

to:

```typescript
  const result = await syncFontdueData({
    sanityClient: client,
    fontdueUrl: fontdueUrl!,
    dryRun,
    onProgress: (stage, current, total) => {
```

- [ ] **Step 3: Update Latinotype webhook route**

In `/Users/bartek14/Documents/WORK/FONTDUE/latinotype/apps/web/src/app/api/sync/route.ts`, remove `referenceTypes: ["typefacePage"],` from the `syncFontdueData` call (around line 83):

Change:

```typescript
    const result = await syncFontdueData({
      sanityClient,
      fontdueUrl,
      triggeredBy: "webhook",
      referenceTypes: ["typefacePage"],
    });
```

to:

```typescript
    const result = await syncFontdueData({
      sanityClient,
      fontdueUrl,
      triggeredBy: "webhook",
    });
```

- [ ] **Step 4: Commit each project separately**

```bash
cd /Users/bartek14/Documents/WORK/FONTDUE/monokrom
git add studio/scripts/fontdue/sync-fontdue.ts
git commit -m "refactor: remove referenceTypes from fontdue sync (now handled automatically)"

cd /Users/bartek14/Documents/WORK/FONTDUE/latinotype
git add apps/studio/scripts/sync-fontdue.ts apps/web/src/app/api/sync/route.ts
git commit -m "refactor: remove referenceTypes from fontdue sync (now handled automatically)"
```

---

### Task 6: Build, publish, and update consumers

**Files:**
- Modify: `_packages/sanity-fontdue/package.json` (version bump)

- [ ] **Step 1: Bump version to 0.2.0**

In `/Users/bartek14/Documents/WORK/FONTDUE/_packages/sanity-fontdue/package.json`, change version:

```json
"version": "0.2.0",
```

- [ ] **Step 2: Build the package**

Run: `cd /Users/bartek14/Documents/WORK/FONTDUE/_packages/sanity-fontdue && npm run build`
Expected: Successful compilation, dist/ updated

- [ ] **Step 3: Publish to npm**

Run: `cd /Users/bartek14/Documents/WORK/FONTDUE/_packages/sanity-fontdue && npm publish`
Expected: Published `fontdue-sanity-sync@0.2.0`

- [ ] **Step 4: Update consumers**

```bash
cd /Users/bartek14/Documents/WORK/FONTDUE/monokrom && npm install fontdue-sanity-sync@0.2.0 -w studio -w web
cd /Users/bartek14/Documents/WORK/FONTDUE/latinotype && npm install fontdue-sanity-sync@0.2.0 -w apps/studio -w apps/web
```

- [ ] **Step 5: Test Monokrom sync with dry-run**

Run: `cd /Users/bartek14/Documents/WORK/FONTDUE/monokrom/studio && npm run sync:dry`
Expected: Completes without errors, shows planned changes

- [ ] **Step 6: Commit version bump and lock files**

```bash
cd /Users/bartek14/Documents/WORK/FONTDUE/_packages/sanity-fontdue
git add package.json
git commit -m "chore: bump version to 0.2.0"

cd /Users/bartek14/Documents/WORK/FONTDUE/monokrom
git add package.json package-lock.json studio/package.json web/package.json
git commit -m "chore: update fontdue-sanity-sync to 0.2.0"

cd /Users/bartek14/Documents/WORK/FONTDUE/latinotype
git add package.json package-lock.json apps/studio/package.json apps/web/package.json
git commit -m "chore: update fontdue-sanity-sync to 0.2.0"
```

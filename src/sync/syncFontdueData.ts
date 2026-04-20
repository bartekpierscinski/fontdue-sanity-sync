import type { SanityClient } from "@sanity/client";
import type { SyncOptions, SyncResult, SyncStats } from "./types.js";
import { toSanityId, chunk } from "./utils.js";
import { cleanupExternalReferences } from "./cleanupReferences.js";

interface FontdueCollection {
  id: string;
  name: string;
  slug: { name: string } | null;
  collectionType: string;
  parent: { id: string } | null;
  fontStyles: FontdueStyle[];
  featureStyle: { id: string } | null;
  updatedAt: string | null;
}

interface FontdueStyle {
  id: string;
  name: string;
  dateModified: string | null;
  versionString: string | null;
}

interface FontdueLicense {
  id: string;
  name: string;
  slug: { name: string } | null;
}

const SYNC_QUERY = `
  query SyncData {
    viewer {
      fontCollections(first: 1000) {
        edges {
          node {
            id
            name
            slug { name }
            collectionType
            parent { id }
            updatedAt
            featureStyle { id }
            fontStyles {
              id
              name
              dateModified
              versionString
            }
          }
        }
      }
      licenses {
        id
        name
        slug { name }
      }
    }
  }
`;

/**
 * Sync Fontdue data to Sanity.
 *
 * Fetches collections, styles, and licenses from Fontdue and creates/updates
 * corresponding documents in Sanity. Cleans up orphaned documents that no
 * longer exist in Fontdue, removing all references before deletion.
 */
export async function syncFontdueData({
  sanityClient,
  fontdueUrl,
  onProgress,
  batchSize = 50,
  triggeredBy = "manual",
  dryRun = false,
  includeParentRef = false,
  includeFamilyRef = false,
  includeUpdatedAt = false,
  includeStyleFontMetadata = false,
  includeFeatureStyleRef = false,
  storeSyncStatus = true,
}: SyncOptions): Promise<SyncResult> {
  const startTime = Date.now();
  const progress = onProgress || (() => {});

  // --- Phase 1: Fetch data from Fontdue ---
  progress("Fetching from Fontdue", 0, 1);
  const response = await fetch(`${fontdueUrl}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: SYNC_QUERY }),
  });

  const { data } = await response.json();
  progress("Fetching from Fontdue", 1, 1);

  const collections: FontdueCollection[] =
    data.viewer.fontCollections?.edges?.map(
      (edge: { node: FontdueCollection }) => edge.node,
    ) ?? [];

  const licenses: FontdueLicense[] = data.viewer.licenses ?? [];

  // --- Phase 2: Fetch existing Sanity documents ---
  progress("Fetching existing Sanity documents", 0, 1);
  const [existingCollections, existingStyles, existingLicenses] =
    await Promise.all([
      sanityClient.fetch<any[]>(
        `*[_type == "fontdueCollection"]{ _id, fontdueId, name, slug, collectionType, children, styles, updatedAt }`,
      ),
      sanityClient.fetch<any[]>(
        `*[_type == "fontdueStyle"]{ _id, fontdueId, name, dateModified, versionString }`,
      ),
      sanityClient.fetch<any[]>(
        `*[_type == "fontdueLicense"]{ _id, fontdueId, name, slug }`,
      ),
    ]);
  progress("Fetching existing Sanity documents", 1, 1);

  const existingCollectionsMap = new Map(
    existingCollections.map((d) => [d._id, d]),
  );
  const existingStylesMap = new Map(existingStyles.map((d) => [d._id, d]));
  const existingLicensesMap = new Map(existingLicenses.map((d) => [d._id, d]));

  const stats = {
    collections: {
      created: 0,
      updated: 0,
      deleted: 0,
      skippedUnchanged: 0,
    },
    styles: { created: 0, updated: 0, deleted: 0, skippedUnchanged: 0 },
    licenses: { created: 0, updated: 0, deleted: 0, skippedUnchanged: 0 },
  };

  const syncedCollectionIds = new Set<string>();
  const syncedStyleIds = new Set<string>();
  const syncedLicenseIds = new Set<string>();

  // --- Phase 3: Build & sync collection documents ---
  const collectionIdMap = new Map<string, string>();
  const collectionDocs = collections.map((collection) => {
    const sanityId = toSanityId("fontdueCollection", collection.id);
    collectionIdMap.set(collection.id, sanityId);
    syncedCollectionIds.add(sanityId);

    const doc: { _id: string; _type: string; [key: string]: unknown } = {
      _id: sanityId,
      _type: "fontdueCollection",
      fontdueId: collection.id,
      name: collection.name,
      slug: collection.slug?.name || null,
      collectionType: collection.collectionType,
    };

    if (includeUpdatedAt && collection.updatedAt) {
      doc.updatedAt = collection.updatedAt;
    }

    // Include parent reference directly if parent was already processed
    if (includeParentRef && collection.parent?.id) {
      const parentSanityId = collectionIdMap.get(collection.parent.id);
      if (parentSanityId) {
        doc.parent = { _type: "reference", _ref: parentSanityId };
      }
    }

    return doc;
  });

  // Change detection: only update if fields actually changed
  const docsToUpdateCollection = [];
  for (const doc of collectionDocs) {
    const existing = existingCollectionsMap.get(doc._id as string);
    if (!existing) {
      stats.collections.created++;
      docsToUpdateCollection.push(doc);
    } else {
      if (
        existing.fontdueId !== doc.fontdueId ||
        existing.name !== doc.name ||
        existing.slug !== doc.slug ||
        existing.collectionType !== doc.collectionType
      ) {
        stats.collections.updated++;
        docsToUpdateCollection.push(doc);
      } else {
        stats.collections.skippedUnchanged++;
      }
    }
  }

  if (!dryRun && docsToUpdateCollection.length > 0) {
    const collectionBatches = chunk(docsToUpdateCollection, batchSize);
    let processed = 0;
    for (const batch of collectionBatches) {
      progress(
        "Syncing collections",
        processed,
        docsToUpdateCollection.length,
      );
      const transaction = sanityClient.transaction();
      for (const doc of batch) {
        transaction.createOrReplace(doc);
      }
      await transaction.commit({ visibility: "sync" });
      processed += batch.length;
    }
    progress(
      "Syncing collections",
      docsToUpdateCollection.length,
      docsToUpdateCollection.length,
    );
  }

  // --- Phase 4: Build relationship patches ---

  // 4a: Parent references for collections where parent came after child in the list
  const parentPatches: { sanityId: string; patch: Record<string, unknown> }[] =
    [];
  if (includeParentRef) {
    for (const collection of collections) {
      if (collection.parent?.id) {
        const sanityId = collectionIdMap.get(collection.id);
        const parentSanityId = collectionIdMap.get(collection.parent.id);
        // Only patch if parent wasn't included in the initial createOrReplace
        const initialDoc = collectionDocs.find((d) => d._id === sanityId);
        if (sanityId && parentSanityId && !initialDoc?.parent) {
          parentPatches.push({
            sanityId,
            patch: { parent: { _type: "reference", _ref: parentSanityId } },
          });
        }
      }
    }
  }

  // 4b: Children arrays for superfamilies (only if changed)
  const childrenByParent = new Map<string, string[]>();
  for (const collection of collections) {
    if (collection.parent?.id) {
      const parentSanityId = collectionIdMap.get(collection.parent.id);
      const childSanityId = collectionIdMap.get(collection.id);
      if (parentSanityId && childSanityId) {
        if (!childrenByParent.has(parentSanityId)) {
          childrenByParent.set(parentSanityId, []);
        }
        childrenByParent.get(parentSanityId)!.push(childSanityId);
      }
    }
  }

  const childrenPatches = Array.from(childrenByParent.entries())
    .map(([parentId, childIds]) => ({
      sanityId: parentId,
      patch: {
        children: childIds.map((id) => ({
          _type: "reference",
          _ref: id,
          _key: id,
        })),
      },
    }))
    .filter(({ sanityId, patch }) => {
      const existing = existingCollectionsMap.get(sanityId);
      if (!existing) return true;
      const existingRefs = (existing.children || [])
        .map((c: { _ref: string }) => c._ref)
        .sort();
      const newRefs = patch.children.map((c) => c._ref).sort();
      return (
        existingRefs.length !== newRefs.length ||
        existingRefs.some((ref: string, i: number) => ref !== newRefs[i])
      );
    });

  const allRelationshipPatches = [...parentPatches, ...childrenPatches];

  if (!dryRun && allRelationshipPatches.length > 0) {
    const patchBatches = chunk(allRelationshipPatches, batchSize);
    let processed = 0;
    for (const batch of patchBatches) {
      progress(
        "Setting collection relationships",
        processed,
        allRelationshipPatches.length,
      );
      const transaction = sanityClient.transaction();
      for (const { sanityId, patch } of batch) {
        transaction.patch(sanityId, (p) => p.set(patch));
      }
      await transaction.commit({ visibility: "sync" });
      processed += batch.length;
    }
    progress(
      "Setting collection relationships",
      allRelationshipPatches.length,
      allRelationshipPatches.length,
    );
  }

  // --- Phase 5: Build & sync style documents ---
  const stylesByFamily = new Map<string, string[]>();
  const styleDocs = collections.flatMap((collection) =>
    collection.fontStyles.map((style) => {
      const sanityId = toSanityId("fontdueStyle", style.id);
      const collectionSanityId = collectionIdMap.get(collection.id);
      syncedStyleIds.add(sanityId);

      if (collectionSanityId) {
        if (!stylesByFamily.has(collectionSanityId)) {
          stylesByFamily.set(collectionSanityId, []);
        }
        stylesByFamily.get(collectionSanityId)!.push(sanityId);
      }

      const doc: { _id: string; _type: string; [key: string]: unknown } = {
        _id: sanityId,
        _type: "fontdueStyle",
        fontdueId: style.id,
        name: style.name,
      };

      if (includeFamilyRef && collectionSanityId) {
        doc.family = { _type: "reference", _ref: collectionSanityId };
      }

      if (includeStyleFontMetadata) {
        if (style.dateModified) doc.dateModified = style.dateModified;
        if (style.versionString) doc.versionString = style.versionString;
      }

      return doc;
    }),
  );

  const docsToUpdateStyle = [];
  for (const doc of styleDocs) {
    const existing = existingStylesMap.get(doc._id as string);
    if (!existing) {
      stats.styles.created++;
      docsToUpdateStyle.push(doc);
      continue;
    }
    const basicChanged =
      existing.fontdueId !== doc.fontdueId || existing.name !== doc.name;
    const metadataChanged =
      includeStyleFontMetadata &&
      (existing.dateModified !== doc.dateModified ||
        existing.versionString !== doc.versionString);
    if (basicChanged || metadataChanged) {
      stats.styles.updated++;
      docsToUpdateStyle.push(doc);
    } else {
      stats.styles.skippedUnchanged++;
    }
  }

  if (!dryRun && docsToUpdateStyle.length > 0) {
    const styleBatches = chunk(docsToUpdateStyle, batchSize);
    let processed = 0;
    for (const batch of styleBatches) {
      progress("Syncing styles", processed, docsToUpdateStyle.length);
      const transaction = sanityClient.transaction();
      for (const doc of batch) {
        transaction.createOrReplace(doc);
      }
      await transaction.commit({ visibility: "sync" });
      processed += batch.length;
    }
    progress(
      "Syncing styles",
      docsToUpdateStyle.length,
      docsToUpdateStyle.length,
    );
  }

  // Link styles to families (only if changed)
  const stylePatches = Array.from(stylesByFamily.entries())
    .map(([familyId, styleIds]) => ({
      sanityId: familyId,
      patch: {
        styles: styleIds.map((id) => ({
          _type: "reference",
          _ref: id,
          _key: id,
        })),
      },
    }))
    .filter(({ sanityId, patch }) => {
      const existing = existingCollectionsMap.get(sanityId);
      if (!existing) return true;
      const existingRefs = (existing.styles || [])
        .map((s: { _ref: string }) => s._ref)
        .sort();
      const newRefs = patch.styles.map((s) => s._ref).sort();
      return (
        existingRefs.length !== newRefs.length ||
        existingRefs.some((ref: string, i: number) => ref !== newRefs[i])
      );
    });

  if (!dryRun && stylePatches.length > 0) {
    const stylePatchBatches = chunk(stylePatches, batchSize);
    let processed = 0;
    for (const batch of stylePatchBatches) {
      progress("Linking styles to families", processed, stylePatches.length);
      const transaction = sanityClient.transaction();
      for (const { sanityId, patch } of batch) {
        transaction.patch(sanityId, (p) => p.set(patch));
      }
      await transaction.commit({ visibility: "sync" });
      processed += batch.length;
    }
    progress(
      "Linking styles to families",
      stylePatches.length,
      stylePatches.length,
    );
  }

  // --- Phase 6: Build & sync license documents ---
  const licenseDocs = licenses.map((license) => {
    const sanityId = toSanityId("fontdueLicense", license.id);
    syncedLicenseIds.add(sanityId);
    return {
      _id: sanityId,
      _type: "fontdueLicense" as const,
      fontdueId: license.id,
      name: license.name,
      slug: license.slug?.name || null,
    };
  });

  const docsToUpdateLicense = [];
  for (const doc of licenseDocs) {
    const existing = existingLicensesMap.get(doc._id);
    if (!existing) {
      stats.licenses.created++;
      docsToUpdateLicense.push(doc);
    } else {
      if (
        existing.fontdueId !== doc.fontdueId ||
        existing.name !== doc.name ||
        existing.slug !== doc.slug
      ) {
        stats.licenses.updated++;
        docsToUpdateLicense.push(doc);
      } else {
        stats.licenses.skippedUnchanged++;
      }
    }
  }

  if (!dryRun && docsToUpdateLicense.length > 0) {
    const licenseBatches = chunk(docsToUpdateLicense, batchSize);
    let processed = 0;
    for (const batch of licenseBatches) {
      progress("Syncing licenses", processed, docsToUpdateLicense.length);
      const transaction = sanityClient.transaction();
      for (const doc of batch) {
        transaction.createOrReplace(doc);
      }
      await transaction.commit({ visibility: "sync" });
      processed += batch.length;
    }
    progress(
      "Syncing licenses",
      docsToUpdateLicense.length,
      docsToUpdateLicense.length,
    );
  }

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

    // Step 2: Clean external references (any document referencing orphaned IDs)
    await cleanupExternalReferences({
      sanityClient,
      orphanedIds: allOrphanedIds,
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
      await transaction.commit({ visibility: "sync" });
      processed += batch.length;
    }
    progress(
      "Deleting orphaned documents",
      allOrphanedIds.length,
      allOrphanedIds.length,
    );
  }

  // --- Phase 8: Save sync status ---
  const durationMs = Date.now() - startTime;

  const result: SyncResult = {
    collections: stats.collections,
    styles: stats.styles,
    licenses: stats.licenses,
    durationMs,
    triggeredBy,
    status: "success",
  };

  if (!dryRun && storeSyncStatus !== false) {
    const syncStatusDoc = {
      _id: "fontdueSyncStatus",
      _type: "fontdueSyncStatus",
      lastSync: new Date().toISOString(),
      collections: stats.collections,
      styles: stats.styles,
      licenses: stats.licenses,
      durationMs,
      triggeredBy,
      status: "success" as const,
    };
    await sanityClient.createOrReplace(syncStatusDoc);
  }

  return result;
}

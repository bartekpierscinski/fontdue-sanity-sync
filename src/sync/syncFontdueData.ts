import type { SanityClient } from "@sanity/client";
import type { SyncOptions, SyncResult, SyncStats } from "./types.js";
import { toSanityId, chunk } from "./utils.js";
import { cleanupExternalReferences } from "./cleanupReferences.js";
import { fontdueRequest } from "./fontdueRequest.js";
import {
  buildPackDocument,
  fetchFontduePacks,
  packChanged,
  type PackDocument,
} from "./packs.js";

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

interface SyncResponse {
  viewer: {
    fontCollections: { edges: { node: FontdueCollection }[] } | null;
    licenses: FontdueLicense[] | null;
  } | null;
}

/** Unchanged since 0.3.1: consumers that set no new option issue this exact request */
export const SYNC_QUERY = `
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

/** Documents this package writes; references between them never keep an orphan alive */
const SYNCED_TYPES = ["fontdueCollection", "fontdueStyle", "fontdueLicense", "fontduePack"];

function emptyStats(): SyncStats {
  return { created: 0, updated: 0, deleted: 0, skippedUnchanged: 0 };
}

type Patch = { sanityId: string; patch: Record<string, unknown> };

async function commitPatches(
  sanityClient: SanityClient,
  patches: Patch[],
  batchSize: number,
  stage: string,
  progress: (stage: string, current: number, total: number) => void,
): Promise<void> {
  const batches = chunk(patches, batchSize);
  let processed = 0;
  for (const batch of batches) {
    progress(stage, processed, patches.length);
    const transaction = sanityClient.transaction();
    for (const { sanityId, patch } of batch) {
      transaction.patch(sanityId, (p) => p.set(patch));
    }
    await transaction.commit({ visibility: "sync" });
    processed += batch.length;
  }
  progress(stage, patches.length, patches.length);
}

async function commitDocuments(
  sanityClient: SanityClient,
  docs: { _id: string; _type: string }[],
  batchSize: number,
  stage: string,
  progress: (stage: string, current: number, total: number) => void,
): Promise<void> {
  const batches = chunk(docs, batchSize);
  let processed = 0;
  for (const batch of batches) {
    progress(stage, processed, docs.length);
    const transaction = sanityClient.transaction();
    for (const doc of batch) {
      transaction.createOrReplace(doc);
    }
    await transaction.commit({ visibility: "sync" });
    processed += batch.length;
  }
  progress(stage, docs.length, docs.length);
}

function sameRefsSorted(existing: { _ref: string }[] | undefined, next: { _ref: string }[]): boolean {
  const a = (existing || []).map((r) => r._ref).sort();
  const b = next.map((r) => r._ref).sort();
  return a.length === b.length && a.every((ref, i) => ref === b[i]);
}

/**
 * Sync Fontdue data to Sanity.
 *
 * Fetches collections, styles and licenses (and, with `syncPacks`, font
 * packs) from Fontdue and creates/updates the corresponding documents in
 * Sanity. Documents that are no longer in Fontdue are deleted after every
 * reference to them is removed, or, with `orphanStrategy: "softDelete"`,
 * kept and flagged while something still references them.
 *
 * Nothing is written before Fontdue has answered without errors, and a run
 * in which Fontdue lists no collections at all aborts unless
 * `allowEmptyCatalog` is set, so one bad response cannot empty the dataset.
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
  syncPacks = false,
  orphanStrategy = "delete",
  allowEmptyCatalog = false,
}: SyncOptions): Promise<SyncResult> {
  const startTime = Date.now();
  const progress = onProgress || (() => {});
  const softDelete = orphanStrategy === "softDelete";

  // --- Phase 1: Fetch data from Fontdue (throws on any error, before any write) ---
  progress("Fetching from Fontdue", 0, 1);
  const data = await fontdueRequest<SyncResponse>(fontdueUrl, SYNC_QUERY);
  progress("Fetching from Fontdue", 1, 1);

  const connection = data.viewer?.fontCollections;
  if (!connection) {
    throw new Error(
      "Fontdue returned no font collection connection; nothing was written",
    );
  }

  const collections: FontdueCollection[] = (connection.edges ?? [])
    .map((edge) => edge?.node)
    .filter((node): node is FontdueCollection => Boolean(node));
  const licenses: FontdueLicense[] = data.viewer?.licenses ?? [];

  // Packs are fetched up front too, so a failing pack request is known
  // before the first write; the documents are built once styles exist (6b).
  const packsFetch = syncPacks ? await fetchFontduePacks(fontdueUrl) : null;

  // --- Phase 2: Fetch existing Sanity documents ---
  progress("Fetching existing Sanity documents", 0, 1);
  const [existingCollections, existingStyles, existingLicenses, existingPacks] =
    await Promise.all([
      sanityClient.fetch<any[]>(
        `*[_type == "fontdueCollection"]{ _id, fontdueId, name, slug, collectionType, parent, children, styles, updatedAt, featureStyle, isDeleted }`,
      ),
      sanityClient.fetch<any[]>(
        `*[_type == "fontdueStyle"]{ _id, fontdueId, name, dateModified, versionString }`,
      ),
      sanityClient.fetch<any[]>(
        `*[_type == "fontdueLicense"]{ _id, fontdueId, name, slug }`,
      ),
      syncPacks
        ? sanityClient.fetch<any[]>(
            `*[_type == "fontduePack"]{ _id, fontdueId, name, slug, visibility, totalStyles, members, isDeleted }`,
          )
        : Promise.resolve([] as any[]),
    ]);
  progress("Fetching existing Sanity documents", 1, 1);

  if (collections.length === 0 && existingCollections.length > 0 && !allowEmptyCatalog) {
    throw new Error(
      `Fontdue returned no collections while Sanity holds ${existingCollections.length}; aborting before any write. Pass allowEmptyCatalog: true if the catalog really is empty.`,
    );
  }

  const existingCollectionsMap = new Map(
    existingCollections.map((d) => [d._id, d]),
  );
  const existingStylesMap = new Map(existingStyles.map((d) => [d._id, d]));
  const existingLicensesMap = new Map(existingLicenses.map((d) => [d._id, d]));
  const existingPacksMap = new Map(existingPacks.map((d) => [d._id, d]));

  const stats = {
    collections: emptyStats(),
    styles: emptyStats(),
    licenses: emptyStats(),
  };

  const syncedCollectionIds = new Set<string>();
  const syncedStyleIds = new Set<string>();
  const syncedLicenseIds = new Set<string>();

  // --- Phase 3: Build & sync collection documents ---
  // Ids are mapped up front so a child listed before its superfamily still
  // gets its parent reference in the document itself
  const collectionIdMap = new Map<string, string>(
    collections.map((c) => [c.id, toSanityId("fontdueCollection", c.id)]),
  );
  const collectionDocs = collections.map((collection) => {
    const sanityId = collectionIdMap.get(collection.id)!;
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

    if (includeParentRef && collection.parent?.id) {
      const parentSanityId = collectionIdMap.get(collection.parent.id);
      if (parentSanityId) {
        doc.parent = { _type: "reference", _ref: parentSanityId };
      }
    }

    return doc;
  });

  // Change detection: only update if fields actually changed. A document
  // flagged isDeleted that is back in Fontdue is rewritten (which drops the flag).
  // A parent change counts too, so moving a family into or out of a
  // superfamily reaches Sanity.
  const docsToUpdateCollection = [];
  for (const doc of collectionDocs) {
    const existing = existingCollectionsMap.get(doc._id as string);
    const parentRef = (doc.parent as { _ref?: string } | undefined)?._ref;
    if (!existing) {
      stats.collections.created++;
      docsToUpdateCollection.push(doc);
    } else if (
      existing.fontdueId !== doc.fontdueId ||
      existing.name !== doc.name ||
      existing.slug !== doc.slug ||
      existing.collectionType !== doc.collectionType ||
      existing.isDeleted === true ||
      (includeParentRef && existing.parent?._ref !== parentRef)
    ) {
      stats.collections.updated++;
      docsToUpdateCollection.push(doc);
    } else {
      stats.collections.skippedUnchanged++;
    }
  }

  // createOrReplace drops children, styles and featureStyle, so the
  // relationship checks below must treat a rewritten document as having none,
  // not compare against what it held before this run
  const rewrittenCollectionIds = new Set(docsToUpdateCollection.map((d) => d._id));
  const collectionStateAfterWrite = (sanityId: string) =>
    rewrittenCollectionIds.has(sanityId) ? undefined : existingCollectionsMap.get(sanityId);

  if (!dryRun && docsToUpdateCollection.length > 0) {
    await commitDocuments(sanityClient, docsToUpdateCollection, batchSize, "Syncing collections", progress);
  }

  // --- Phase 4: Children arrays for superfamilies (only if changed) ---
  // Parent references are part of the collection documents written above.
  // Every synced collection is checked, so a superfamily whose last family
  // left gets an empty children array instead of keeping the stale one.
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

  const childrenPatches: Patch[] = collectionDocs
    .map(({ _id }) => ({
      sanityId: _id,
      patch: {
        children: (childrenByParent.get(_id) ?? []).map((id) => ({
          _type: "reference",
          _ref: id,
          _key: id,
        })),
      },
    }))
    .filter(({ sanityId, patch }) =>
      !sameRefsSorted(
        collectionStateAfterWrite(sanityId)?.children,
        patch.children as { _ref: string }[],
      ),
    );

  if (!dryRun && childrenPatches.length > 0) {
    await commitPatches(sanityClient, childrenPatches, batchSize, "Setting collection relationships", progress);
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
    await commitDocuments(sanityClient, docsToUpdateStyle, batchSize, "Syncing styles", progress);
  }

  // 5b: Feature-style reference on collections (only if changed)
  const featureStylePatches: Patch[] = [];
  if (includeFeatureStyleRef) {
    for (const collection of collections) {
      if (!collection.featureStyle?.id) continue;
      const collectionSanityId = collectionIdMap.get(collection.id);
      const featureStyleSanityId = toSanityId(
        "fontdueStyle",
        collection.featureStyle.id,
      );
      if (!collectionSanityId || !syncedStyleIds.has(featureStyleSanityId)) {
        continue;
      }
      const existing = collectionStateAfterWrite(collectionSanityId);
      const existingRef = (
        existing?.featureStyle as { _ref?: string } | undefined
      )?._ref;
      if (existingRef === featureStyleSanityId) continue;
      featureStylePatches.push({
        sanityId: collectionSanityId,
        patch: {
          featureStyle: {
            _type: "reference",
            _ref: featureStyleSanityId,
          },
        },
      });
    }
  }

  if (!dryRun && featureStylePatches.length > 0) {
    await commitPatches(sanityClient, featureStylePatches, batchSize, "Setting feature style references", progress);
  }

  // Link styles to families (only if changed)
  const stylePatches: Patch[] = Array.from(stylesByFamily.entries())
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
    .filter(({ sanityId, patch }) =>
      !sameRefsSorted(
        collectionStateAfterWrite(sanityId)?.styles,
        patch.styles as { _ref: string }[],
      ),
    );

  if (!dryRun && stylePatches.length > 0) {
    await commitPatches(sanityClient, stylePatches, batchSize, "Linking styles to families", progress);
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
    } else if (
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

  if (!dryRun && docsToUpdateLicense.length > 0) {
    await commitDocuments(sanityClient, docsToUpdateLicense, batchSize, "Syncing licenses", progress);
  }

  // --- Phase 6b: Build & sync font pack documents ---
  // After styles and collections exist (a pack holds strong references to
  // both) and before orphan handling (so a rewritten pack no longer points
  // at a style that is about to go). A skipped fetch leaves every existing
  // pack document exactly as it is.
  let packStats: SyncStats | undefined;
  let packsSkipped: string | undefined;
  const syncedPackIds = new Set<string>();
  let packPhaseRan = false;

  if (packsFetch) {
    if (packsFetch.status === "skipped") {
      packsSkipped = packsFetch.reason;
    } else {
      packPhaseRan = true;
      packStats = emptyStats();
      let unresolvedMembers = 0;
      const packDocs: PackDocument[] = packsFetch.packs.map((pack) => {
        const built = buildPackDocument(pack, syncedCollectionIds, syncedStyleIds);
        unresolvedMembers += built.unresolvedMembers;
        syncedPackIds.add(built.doc._id);
        return built.doc;
      });

      const docsToUpdatePack: PackDocument[] = [];
      for (const doc of packDocs) {
        const existing = existingPacksMap.get(doc._id);
        if (!existing) {
          packStats.created++;
          docsToUpdatePack.push(doc);
        } else if (packChanged(existing, doc)) {
          packStats.updated++;
          docsToUpdatePack.push(doc);
        } else {
          packStats.skippedUnchanged++;
        }
      }

      if (!dryRun && docsToUpdatePack.length > 0) {
        await commitDocuments(sanityClient, docsToUpdatePack, batchSize, "Syncing font packs", progress);
      }
      if (unresolvedMembers > 0) {
        progress("Font pack members without a synced target (left out)", unresolvedMembers, unresolvedMembers);
      }
    }
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
  // Pack orphans exist only when the pack phase ran: a skipped or disabled
  // pack sync must never read as "every pack is gone"
  const orphanedPackIds = packPhaseRan
    ? Array.from(existingPacksMap.keys()).filter((id) => !syncedPackIds.has(id))
    : [];

  stats.styles.deleted = orphanedStyleIds.length;
  stats.collections.deleted = orphanedCollectionIds.length;
  stats.licenses.deleted = orphanedLicenseIds.length;
  if (packStats) packStats.deleted = orphanedPackIds.length;

  // Soft delete: a collection or pack that any document outside this
  // package's own types still references is kept and flagged; references
  // held only by synced documents (a superfamily's children, a family's
  // styles, a pack's members) do not count, or every orphan would look alive
  let collectionsToHardDelete = orphanedCollectionIds;
  let packsToHardDelete = orphanedPackIds;
  let toSoftDelete: string[] = [];

  if (softDelete && (orphanedCollectionIds.length > 0 || orphanedPackIds.length > 0)) {
    progress("Checking references to removed documents", 0, 1);
    const candidates = [...orphanedCollectionIds, ...orphanedPackIds];
    const referenced = await sanityClient.fetch<{ _id: string; referenced: boolean }[]>(
      `*[_id in $ids]{ _id, "referenced": count(*[references(^._id) && !(_type in $syncedTypes)]) > 0 }`,
      { ids: candidates, syncedTypes: SYNCED_TYPES },
    );
    progress("Checking references to removed documents", 1, 1);
    const referencedSet = new Set(referenced.filter((r) => r.referenced).map((r) => r._id));
    toSoftDelete = candidates.filter((id) => referencedSet.has(id));
    collectionsToHardDelete = orphanedCollectionIds.filter((id) => !referencedSet.has(id));
    packsToHardDelete = orphanedPackIds.filter((id) => !referencedSet.has(id));
  }

  // Flag newly removed documents; ones already flagged are left alone so a
  // steady state writes nothing (and wakes no webhook)
  const softDeletePatches: Patch[] = toSoftDelete
    .filter((id) => {
      const existing = existingCollectionsMap.get(id) ?? existingPacksMap.get(id);
      return existing?.isDeleted !== true;
    })
    .map((id) => ({
      sanityId: id,
      patch: { isDeleted: true, deletedAt: new Date().toISOString() },
    }));

  if (!dryRun && softDeletePatches.length > 0) {
    await commitPatches(sanityClient, softDeletePatches, batchSize, "Flagging removed documents", progress);
  }

  const allHardDeleteIds = [
    ...packsToHardDelete,
    ...collectionsToHardDelete,
    ...orphanedStyleIds,
    ...orphanedLicenseIds,
  ];

  if (!dryRun && allHardDeleteIds.length > 0) {
    // Step 1: Clean internal references (fontdueCollection.styles[] and .children[])
    const orphanedStyleSet = new Set(orphanedStyleIds);
    const orphanedCollectionSet = new Set(collectionsToHardDelete);

    const currentCollections = await sanityClient.fetch<any[]>(
      `*[_type == "fontdueCollection"]{ _id, children, styles }`,
    );

    const internalCleanups: Patch[] = [];

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
      await commitPatches(sanityClient, internalCleanups, batchSize, "Removing internal references", progress);
    }

    // Step 2: Clean external references (any document referencing the ids
    // about to be deleted, a pack's members[] included)
    await cleanupExternalReferences({
      sanityClient,
      orphanedIds: allHardDeleteIds,
      batchSize,
      onProgress: progress,
    });

    // Step 3: Hard-delete, packs before collections before styles, so a
    // referencing document never outlives what it references within a batch
    const deleteBatches = chunk(allHardDeleteIds, batchSize);
    let processed = 0;
    for (const batch of deleteBatches) {
      progress("Deleting orphaned documents", processed, allHardDeleteIds.length);
      const transaction = sanityClient.transaction();
      for (const id of batch) {
        transaction.delete(id);
      }
      await transaction.commit({ visibility: "sync" });
      processed += batch.length;
    }
    progress("Deleting orphaned documents", allHardDeleteIds.length, allHardDeleteIds.length);
  }

  // --- Phase 8: Save sync status ---
  const durationMs = Date.now() - startTime;

  const result: SyncResult = {
    collections: stats.collections,
    styles: stats.styles,
    licenses: stats.licenses,
    ...(packStats ? { packs: packStats } : {}),
    ...(packsSkipped ? { packsSkipped } : {}),
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
      ...(packStats ? { packs: packStats } : {}),
      ...(packsSkipped ? { packsSkipped } : {}),
      durationMs,
      triggeredBy,
      status: "success" as const,
    };
    await sanityClient.createOrReplace(syncStatusDoc);
  }

  return result;
}

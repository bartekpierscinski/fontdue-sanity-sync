import type { SanityClient } from "@sanity/client";
import { chunk } from "./utils.js";

/**
 * Find all documents referencing any of the given IDs and build patches
 * to remove those references. Handles both direct reference fields
 * (unset the field) and array reference items (filter them out),
 * including references nested inside array objects (e.g. portable text).
 */
export async function cleanupExternalReferences({
  sanityClient,
  orphanedIds,
  batchSize = 50,
  onProgress,
}: {
  sanityClient: SanityClient;
  orphanedIds: string[];
  batchSize?: number;
  onProgress?: (stage: string, current: number, total: number) => void;
}): Promise<number> {
  if (orphanedIds.length === 0) return 0;

  const progress = onProgress || (() => {});
  const orphanedSet = new Set(orphanedIds);

  // Find all documents that reference any orphaned ID, excluding the
  // orphaned documents themselves (they are about to be deleted).
  progress("Finding external references", 0, 1);
  const referencingDocs = await sanityClient.fetch<any[]>(
    `*[references($ids) && !(_id in $ids)]{...}`,
    { ids: orphanedIds },
  );
  progress("Finding external references", 1, 1);

  if (referencingDocs.length === 0) return 0;

  // For each referencing doc, find which fields contain orphaned refs
  const cleanups: {
    docId: string;
    unsetPaths: string[];
    arrayPatches: Record<string, unknown[]>;
  }[] = [];

  for (const doc of referencingDocs) {
    const unsetPaths: string[] = [];
    const arrayPatches: Record<string, unknown[]> = {};

    walkFields(doc, "", orphanedSet, unsetPaths, arrayPatches);

    if (unsetPaths.length > 0 || Object.keys(arrayPatches).length > 0) {
      cleanups.push({ docId: doc._id, unsetPaths, arrayPatches });
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

    for (const { docId, unsetPaths, arrayPatches } of batch) {
      transaction.patch(docId, (p) => {
        if (unsetPaths.length > 0) {
          p.unset(unsetPaths);
          totalCleaned += unsetPaths.length;
        }

        for (const [path, filtered] of Object.entries(arrayPatches)) {
          p.set({ [path]: filtered });
          totalCleaned++;
        }

        return p;
      });
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
 * - Non-reference objects inside arrays -> recurse into them
 */
function walkFields(
  obj: Record<string, unknown>,
  basePath: string,
  orphanedSet: Set<string>,
  unsetPaths: string[],
  arrayPatches: Record<string, unknown[]>,
): void {
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith("_") && key !== "_ref") continue;

    const currentPath = basePath ? `${basePath}.${key}` : key;

    if (Array.isArray(value)) {
      // Check if any array items are direct references to orphaned IDs
      const hasOrphanedRefs = value.some(
        (item) =>
          item &&
          typeof item === "object" &&
          "_ref" in item &&
          orphanedSet.has((item as { _ref: string })._ref),
      );

      if (hasOrphanedRefs) {
        // Filter out orphaned reference items from the array
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

      // Recurse into non-reference object items (e.g. portable text blocks,
      // structured objects that may contain nested references)
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const record = item as Record<string, unknown>;
          if (!("_ref" in record)) {
            walkFields(
              record,
              `${currentPath}[${i}]`,
              orphanedSet,
              unsetPaths,
              arrayPatches,
            );
          }
        }
      }
    } else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if ("_ref" in record && orphanedSet.has(record._ref as string)) {
        unsetPaths.push(currentPath);
      } else {
        walkFields(record, currentPath, orphanedSet, unsetPaths, arrayPatches);
      }
    }
  }
}

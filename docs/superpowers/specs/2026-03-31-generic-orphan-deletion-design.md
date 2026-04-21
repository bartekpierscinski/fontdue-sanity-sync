# Generic Orphan Deletion with Reference Cleanup

## Problem

When the sync engine deletes orphaned fontdue documents (styles, collections, licenses that no longer exist in Fontdue), it fails if any external Sanity document references them. The current code only cleans internal references (within `fontdueCollection` documents) and only checks external references for collections via a manually configured `referenceTypes`/`referenceField` option. Styles and licenses get no protection at all.

Real-world failure: Monokrom's `typeface` documents have a `leadStyle` field referencing `fontdueStyle` docs. When a style is orphaned, the sync crashes with "cannot be deleted as there are references to it."

## Design

### Core Change

Replace the current approach (manual `referenceTypes`/`referenceField` config + soft-delete for collections, no checking for styles/licenses) with a single generic mechanism:

1. For ALL orphaned documents (collections, styles, licenses), use Sanity's `references()` GROQ function to find every document that references them
2. Fetch those referencing documents, walk their fields, and unset any `_ref` pointing to an orphaned ID
3. Hard-delete all orphaned documents

### What Gets Removed

- `referenceTypes` option from `SyncOptions`
- `referenceField` option from `SyncOptions`
- `includeSoftDelete` option from `SchemaOptions`
- `isDeleted` / `deletedAt` fields from `fontdueCollection` schema
- Soft-delete logic in `syncFontdueData` (the soft-delete branch, the `isDeleted === true` re-sync check)
- The `collectionsToSoftDelete` / `collectionsToHardDelete` split logic

### What Gets Added/Changed

**New generic reference cleanup function** (in `syncFontdueData.ts` or a helper):

```
For a set of orphaned IDs:
1. Query: *[references($ids) && !(_id in $ids)]{ _id, ... }
   (exclude fontdue docs themselves since they'll be deleted anyway)
2. For each referencing document, scan all fields recursively for { _ref: <orphaned-id> }
3. Build patches to unset those fields (for direct refs) or filter them out (for array refs)
4. Commit patches with visibility: "sync"
5. Then hard-delete all orphaned IDs
```

**Reference cleanup covers two patterns:**
- **Direct reference fields** (e.g. `typeface.leadStyle`, `typeface.fontdueCollection`): unset the field
- **Array reference items** (e.g. `fontdueCollection.styles[]`, `fontdueCollection.children[]`): filter out the matching refs from the array

### Sync Flow After Changes

Phase 7 (orphan handling) becomes:

1. Collect all orphaned IDs (styles + collections + licenses)
2. Internal cleanup: remove orphaned refs from `fontdueCollection.styles[]` and `fontdueCollection.children[]` (same as today, keeps it efficient)
3. External cleanup: query `*[references($allOrphanedIds) && _type != "fontdueCollection"]`, fetch full docs, scan fields, unset/filter matching refs
4. Hard-delete all orphaned documents

### Stats Changes

- `SyncStats.deleted` stays as-is (counts all orphaned docs)
- No more distinguishing soft vs hard deletes
- Optionally add `referencesRemoved` count to track how many external refs were cleaned

### Consumer-Side Changes

**Monokrom** `sync-fontdue.ts`:
- Remove `referenceTypes: ["typeface"]` from options (option no longer exists)

**Latinotype** `sync-fontdue.ts` and `route.ts`:
- Remove `referenceTypes: ["typefacePage"]` from options

**Schema registrations** in both projects:
- Remove any `includeSoftDelete` option if passed
- The schema will no longer have `isDeleted`/`deletedAt` fields

### Migration Consideration

Existing `fontdueCollection` documents in Sanity may have `isDeleted: true` and `deletedAt` set. After removing these fields from the schema, the data stays in Sanity but becomes invisible (no schema field = not shown in Studio). This is fine since those documents represent things deleted from Fontdue. If they reappear in Fontdue, the sync will `createOrReplace` them with fresh data (without `isDeleted`), which effectively cleans them up. No manual migration needed.

### Edge Cases

- **Circular references between fontdue docs**: The `references()` query excludes fontdue docs being deleted (`!(_id in $ids)`), so internal cross-references won't block deletion. The internal cleanup (step 2) handles `fontdueCollection` arrays.
- **Draft documents**: Sanity's `references()` catches both published and draft docs. The cleanup patches will apply to draft IDs too.
- **Large orphan sets**: The `references()` query accepts an array param, so we batch orphan IDs together. The cleanup patches are batched same as today.
- **Dry run**: In dry-run mode, report orphaned counts as today. No reference cleanup or deletion happens.

## Files to Modify

### Package (`_packages/sanity-fontdue/`)
1. `src/sync/types.ts` — remove `referenceTypes`, `referenceField` from `SyncOptions`
2. `src/sync/syncFontdueData.ts` — replace Phase 7 orphan handling
3. `src/schemas/types.ts` — remove `includeSoftDelete` from `SchemaOptions`
4. `src/schemas/fontdueCollection.ts` — remove `isDeleted`/`deletedAt` fields and related preview logic

### Monokrom (`monokrom/`)
5. `studio/scripts/fontdue/sync-fontdue.ts` — remove `referenceTypes` option

### Latinotype (`latinotype/`)
6. `apps/studio/scripts/sync-fontdue.ts` — remove `referenceTypes` option
7. `apps/web/src/app/api/sync/route.ts` — remove `referenceTypes` option

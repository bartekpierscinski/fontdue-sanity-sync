# fontdue-sanity-sync

Sanity schemas and sync engine for [Fontdue](https://fontdue.com) font data.

Syncs font collections, styles, licenses and, optionally, font packs from Fontdue's GraphQL API into Sanity CMS as read-only documents. Documents that leave Fontdue are deleted after every reference to them is cleaned up, or kept and flagged while something still references them.

## Install

```bash
npm install fontdue-sanity-sync
```

## Usage

### Register schemas in Sanity Studio

```typescript
import { fontdueSchemas } from "fontdue-sanity-sync";

export default defineConfig({
  schema: {
    types: [...fontdueSchemas, /* your schemas */],
  },
});
```

Or with custom options:

```typescript
import { createFontdueSchemas } from "fontdue-sanity-sync";

const fontdueSchemas = createFontdueSchemas({
  includeParentRef: true,         // Add parent reference on collections
  includeFamilyRef: true,         // Add family reference on styles
  includeUpdatedAt: true,         // Add updatedAt field on collections
  includeStyleFontMetadata: true, // dateModified + versionString on fontdueStyle
  includeFeatureStyleRef: true,   // featureStyle reference on fontdueCollection
  includePacks: true,             // Register the fontduePack document type
  includeSoftDelete: true,        // Declare isDeleted / deletedAt (see Deletion behavior)
});
```

Individual factories are exported too: `createFontdueCollection`, `createFontdueStyle`, `createFontdueLicense`, `createFontduePack`, `createFontdueSyncStatus`.

### Run sync

```typescript
import { syncFontdueData } from "fontdue-sanity-sync";

const result = await syncFontdueData({
  sanityClient,
  fontdueUrl: "https://your-store.fontdue.com",
});
```

### Sync options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `sanityClient` | `SanityClient` | required | Sanity client with write access |
| `fontdueUrl` | `string` | required | Your Fontdue store URL |
| `onProgress` | `function` | — | Progress callback `(stage, current, total)` |
| `batchSize` | `number` | `50` | Documents per transaction batch |
| `triggeredBy` | `string` | `"manual"` | `"manual"`, `"webhook"`, or `"cron"` |
| `dryRun` | `boolean` | `false` | Preview changes without applying |
| `includeParentRef` | `boolean` | `false` | Sync parent references on collections |
| `includeFamilyRef` | `boolean` | `false` | Sync family references on styles |
| `includeUpdatedAt` | `boolean` | `false` | Write updatedAt field on collections |
| `includeStyleFontMetadata` | `boolean` | `false` | Write `dateModified` and `versionString` on styles |
| `includeFeatureStyleRef` | `boolean` | `false` | Write `featureStyle` reference on collections |
| `storeSyncStatus` | `boolean` | `true` | Write a `fontdueSyncStatus` document after sync |
| `syncPacks` | `boolean` | `false` | Mirror font packs as `fontduePack` documents (see Font packs) |
| `orphanStrategy` | `"delete" \| "softDelete"` | `"delete"` | What happens to documents that left Fontdue (see Deletion behavior) |
| `allowEmptyCatalog` | `boolean` | `false` | Allow a run in which Fontdue lists no collections while Sanity holds some |

The result carries per-type stats (`created`, `updated`, `deleted`, `skippedUnchanged`) for `collections`, `styles`, `licenses` and, when the pack phase ran, `packs`; `packsSkipped` says why it did not.

### Font packs

With `includePacks: true` on the schema side and `syncPacks: true` on the sync side, every pack the store offers becomes a read-only `fontduePack` document:

| Field | |
|---|---|
| `fontdueId` | the pack's global id, for reading live data (price, members' prices) from the Fontdue API |
| `name`, `slug` | as set in Fontdue |
| `visibility` | `visible` or `unlisted`; hidden packs are withheld by Fontdue and never sync |
| `totalStyles` | how many styles the pack grants, counted by Fontdue |
| `members[]` | references to the synced `fontdueCollection` (a whole family or superfamily) and `fontdueStyle` documents, in Fontdue's order |

Prices are not mirrored on purpose: they are live data, and writing them into Sanity would wake every webhook on each price edit. Read them from the Fontdue API by `fontdueId` when rendering.

The pack request is issued separately from the catalog request and asks for unlisted packs (`fontPacks(includeUnlisted: true)`); on a backend that predates that argument it retries without it and syncs visible packs only. A backend without font packs, a failed pack request or a missing connection **skip the pack phase**: existing `fontduePack` documents are left exactly as they are, the rest of the sync proceeds, and the reason is reported in `packsSkipped` (and on the `fontdueSyncStatus` document). Only a successful pack response that lists no packs makes existing ones orphans.

A member whose target was not synced in the same run (a style from a hidden family) is left out of `members[]` rather than written as a dangling reference.

### Deletion behavior

"Orphaned" means absent from the store's public API: deleted in Fontdue, or hidden.

With the default `orphanStrategy: "delete"`, the sync engine:

1. Removes internal references (from `fontdueCollection.styles[]` and `.children[]`)
2. Finds and removes **all** external references across the entire dataset (a `fontduePack`'s `members[]` included)
3. Hard-deletes the orphaned documents, packs first, then collections, then styles and licenses

This means you can safely reference synced documents from your own document types: the sync cleans those references up when the source data is removed from Fontdue. Hiding a collection or a pack in Fontdue therefore also unlinks it from your editorial documents, for good.

With `orphanStrategy: "softDelete"`, a **collection or pack** that any document outside this package's own types still references is kept and patched with `isDeleted: true` and `deletedAt`; its incoming references stay intact, and a document that comes back to Fontdue is rewritten without the flag. An orphan nothing references, and every orphaned style and license, is hard-deleted as above. Declare the fields with `includeSoftDelete: true` on the schema side, and filter them out of reference fields and queries (`isDeleted != true`) where a removed document should not be offered.

### Safety

Nothing is written before Fontdue has answered without errors: a non-2xx response or a response carrying GraphQL `errors` throws. A run in which Fontdue lists no collections at all while Sanity still holds some also throws, unless `allowEmptyCatalog: true`, so one bad response cannot delete or unlink every synced document.

## Schemas

- `fontdueCollection` — Font families and superfamilies
- `fontdueStyle` — Font styles within a family
- `fontdueLicense` — License types
- `fontduePack` — Font packs (with `includePacks`)
- `fontdueSyncStatus` — Sync status tracking (singleton)

## Upgrading from 0.1.x

0.2.0 replaced the `referenceTypes` / `referenceField` / `includeSoftDelete` sync options with the automatic reference cleanup described above. A project that relied on soft-deleted collections surviving for its editorial pages gets that behaviour back with `orphanStrategy: "softDelete"` in `syncFontdueData` and `includeSoftDelete: true` in `createFontdueSchemas`. Existing `isDeleted` flags are honoured: a flagged document that is back in Fontdue is rewritten on the next run. Mutations are committed with `visibility: "sync"` since 0.2.0, so a run takes a little longer than under 0.1.x.

## Development

```bash
npm test          # vitest, against an in-memory Sanity stand-in and a mocked Fontdue
npm run build     # tsc to dist/
```

## License

MIT

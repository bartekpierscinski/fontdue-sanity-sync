# fontdue-sanity-sync

Sanity schemas and sync engine for [Fontdue](https://fontdue.com) font data.

Syncs font collections, styles, and licenses from Fontdue's GraphQL API into Sanity CMS as read-only documents. Automatically cleans up all references when documents are deleted from Fontdue.

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
});
```

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

### Deletion behavior

When a font, style, or license is removed from Fontdue, the sync engine:

1. Removes internal references (from `fontdueCollection.styles[]` and `.children[]`)
2. Finds and removes **all** external references across the entire dataset
3. Hard-deletes the orphaned documents

This means you can safely reference `fontdueStyle` or `fontdueCollection` documents from your own document types — the sync will clean up those references automatically when the source data is removed from Fontdue.

## Schemas

- `fontdueCollection` — Font families and superfamilies
- `fontdueStyle` — Font styles within a family
- `fontdueLicense` — License types
- `fontdueSyncStatus` — Sync status tracking (singleton)

## License

MIT

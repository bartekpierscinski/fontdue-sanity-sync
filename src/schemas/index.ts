import { createFontdueCollection } from "./fontdueCollection.js";
import { createFontdueStyle } from "./fontdueStyle.js";
import { createFontdueLicense } from "./fontdueLicense.js";
import { createFontduePack } from "./fontduePack.js";
import { createFontdueSyncStatus } from "./fontdueSyncStatus.js";
import type { SchemaOptions } from "./types.js";

export { createFontdueCollection } from "./fontdueCollection.js";
export { createFontdueStyle } from "./fontdueStyle.js";
export { createFontdueLicense } from "./fontdueLicense.js";
export { createFontduePack } from "./fontduePack.js";
export { createFontdueSyncStatus } from "./fontdueSyncStatus.js";
export type { SchemaOptions } from "./types.js";

export function createFontdueSchemas(options?: SchemaOptions) {
  return [
    createFontdueCollection(options),
    createFontdueStyle(options),
    createFontdueLicense(options),
    ...(options?.includePacks === true ? [createFontduePack(options)] : []),
    createFontdueSyncStatus(),
  ];
}

/** Pre-built schemas with default options (no packs, no soft-delete fields) */
export const fontdueSchemas = createFontdueSchemas();

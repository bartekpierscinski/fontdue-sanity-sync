/**
 * Create a valid Sanity document ID from a Fontdue ID.
 * Fontdue IDs are base64-encoded (e.g., "FontCollection:12345").
 * We decode them to get a cleaner, readable ID.
 *
 * Throws if the ID cannot be decoded or has an unexpected format,
 * to prevent silent ID drift that would cause phantom creates/deletes.
 */
export function toSanityId(prefix: string, fontdueId: string): string {
  const decoded = Buffer.from(fontdueId, "base64").toString("utf-8");
  const numericId = decoded.split(":")[1];
  if (!numericId) {
    throw new Error(
      `Unexpected Fontdue ID format: "${fontdueId}" decoded to "${decoded}" which does not match "Type:id" pattern`,
    );
  }
  return `${prefix}-${numericId}`;
}

/** Split an array into chunks of the given size */
export function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

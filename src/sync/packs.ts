import { FontdueRequestError, fontdueRequest } from "./fontdueRequest.js";
import { toSanityId } from "./utils.js";

export interface FontduePackMember {
  __typename: "FontStyle" | "FontCollection";
  id: string;
}

export interface FontduePack {
  id: string;
  name: string;
  slug: { name: string } | null;
  visibility: string | null;
  totalStyles: number | null;
  members: FontduePackMember[];
}

export interface PackDocument {
  _id: string;
  _type: "fontduePack";
  fontdueId: string;
  name: string;
  slug: string | null;
  visibility: string | null;
  totalStyles: number | null;
  members: { _type: "reference"; _ref: string; _key: string }[];
}

const PACK_FIELDS = `
  id
  name
  slug { name }
  visibility
  totalStyles
  members {
    __typename
    ... on FontStyle { id }
    ... on FontCollection { id }
  }
`;

/**
 * Unlisted packs are for sale but left out of `viewer.fontPacks` unless the
 * listing asks for them, so a site that mirrors packs for its own landing
 * pages asks. A backend that predates the argument rejects it, and the
 * query is retried without it (visible packs only).
 */
export const PACKS_QUERY_WITH_UNLISTED = `
  query SyncPacks {
    viewer {
      fontPacks(first: 1000, includeUnlisted: true) {
        edges { node { ${PACK_FIELDS} } }
      }
    }
  }
`;

export const PACKS_QUERY = `
  query SyncPacks {
    viewer {
      fontPacks(first: 1000) {
        edges { node { ${PACK_FIELDS} } }
      }
    }
  }
`;

interface PacksResponse {
  viewer: {
    fontPacks: { edges: { node: FontduePack }[] } | null;
  } | null;
}

export type PacksFetch =
  | { status: "ok"; packs: FontduePack[]; unlistedIncluded: boolean }
  | { status: "skipped"; reason: string };

function unsupported(error: FontdueRequestError): boolean {
  return (
    error.mentions("fontPacks") ||
    error.mentions("FontPack") ||
    error.mentions("Cannot query field") ||
    error.mentions("Unknown type")
  );
}

/**
 * Fetch every pack the store offers. Never throws: a backend without font
 * packs, a failed request or a missing connection all come back as
 * `skipped`, so existing pack documents are left alone rather than orphaned.
 */
export async function fetchFontduePacks(fontdueUrl: string): Promise<PacksFetch> {
  let unlistedIncluded = true;
  let data: PacksResponse;

  try {
    data = await fontdueRequest<PacksResponse>(fontdueUrl, PACKS_QUERY_WITH_UNLISTED);
  } catch (error) {
    if (error instanceof FontdueRequestError && error.mentions("includeUnlisted")) {
      unlistedIncluded = false;
      try {
        data = await fontdueRequest<PacksResponse>(fontdueUrl, PACKS_QUERY);
      } catch (retryError) {
        return { status: "skipped", reason: skipReason(retryError) };
      }
    } else {
      return { status: "skipped", reason: skipReason(error) };
    }
  }

  const connection = data.viewer?.fontPacks;
  if (!connection) {
    return { status: "skipped", reason: "Fontdue returned no font pack connection" };
  }

  const packs = (connection.edges ?? [])
    .map((edge) => edge?.node)
    .filter((node): node is FontduePack => Boolean(node));

  return { status: "ok", packs, unlistedIncluded };
}

function skipReason(error: unknown): string {
  if (error instanceof FontdueRequestError) {
    return unsupported(error) ? "unsupported" : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build the `fontduePack` document for a pack. Members resolve to the
 * `fontdueStyle` / `fontdueCollection` documents synced in this run; a
 * member whose target was not synced (a hidden family, or a style from one)
 * is dropped and counted, never written as a dangling reference.
 */
export function buildPackDocument(
  pack: FontduePack,
  syncedCollectionIds: Set<string>,
  syncedStyleIds: Set<string>,
): { doc: PackDocument; unresolvedMembers: number } {
  const members: PackDocument["members"] = [];
  const seen = new Set<string>();
  let unresolvedMembers = 0;

  for (const member of pack.members ?? []) {
    const ref =
      member.__typename === "FontStyle"
        ? toSanityId("fontdueStyle", member.id)
        : toSanityId("fontdueCollection", member.id);
    const synced =
      member.__typename === "FontStyle"
        ? syncedStyleIds.has(ref)
        : syncedCollectionIds.has(ref);

    if (!synced) {
      unresolvedMembers++;
      continue;
    }
    if (seen.has(ref)) continue;
    seen.add(ref);
    members.push({ _type: "reference", _ref: ref, _key: ref });
  }

  return {
    doc: {
      _id: toSanityId("fontduePack", pack.id),
      _type: "fontduePack",
      fontdueId: pack.id,
      name: pack.name,
      slug: pack.slug?.name || null,
      visibility: pack.visibility ? pack.visibility.toLowerCase() : null,
      totalStyles: pack.totalStyles ?? null,
      members,
    },
    unresolvedMembers,
  };
}

/**
 * Whether a pack document differs from what is stored. Member order is
 * authored in Fontdue, so it is compared in order, unlike the sorted
 * `children` / `styles` comparison on collections.
 */
export function packChanged(
  existing: Record<string, unknown> | undefined,
  doc: PackDocument,
): boolean {
  if (!existing) return true;
  if (existing.isDeleted === true) return true;
  if (
    existing.fontdueId !== doc.fontdueId ||
    existing.name !== doc.name ||
    (existing.slug ?? null) !== doc.slug ||
    (existing.visibility ?? null) !== doc.visibility ||
    (existing.totalStyles ?? null) !== doc.totalStyles
  ) {
    return true;
  }
  const existingRefs = ((existing.members as { _ref: string }[] | undefined) ?? []).map(
    (m) => m._ref,
  );
  const newRefs = doc.members.map((m) => m._ref);
  return (
    existingRefs.length !== newRefs.length ||
    existingRefs.some((ref, i) => ref !== newRefs[i])
  );
}

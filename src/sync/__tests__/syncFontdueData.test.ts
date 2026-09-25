import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncFontdueData, SYNC_QUERY } from "../syncFontdueData.js";
import { PACKS_QUERY, PACKS_QUERY_WITH_UNLISTED } from "../packs.js";
import { FakeSanity, gid } from "./fakeSanity.js";

// --- Fontdue fixtures -------------------------------------------------------

const styleA = { id: gid("FontStyle", 1), name: "Regular", dateModified: null, versionString: null };
const styleB = { id: gid("FontStyle", 2), name: "Bold", dateModified: null, versionString: null };
const styleC = { id: gid("FontStyle", 3), name: "Regular", dateModified: null, versionString: null };

const superfamily = {
  id: gid("FontCollection", 10),
  name: "Fibra",
  slug: { name: "fibra" },
  collectionType: "superfamily",
  parent: null,
  updatedAt: null,
  featureStyle: null,
  fontStyles: [],
};
const family = {
  id: gid("FontCollection", 11),
  name: "Fibra Basic",
  slug: { name: "fibra-basic" },
  collectionType: "family",
  parent: { id: superfamily.id },
  updatedAt: null,
  featureStyle: { id: styleA.id },
  fontStyles: [styleA, styleB],
};
const standalone = {
  id: gid("FontCollection", 12),
  name: "Stgotic",
  slug: { name: "stgotic" },
  collectionType: "family",
  parent: null,
  updatedAt: null,
  featureStyle: null,
  fontStyles: [styleC],
};
const license = { id: gid("License", 20), name: "Desktop", slug: { name: "desktop" } };

const pack = {
  id: gid("FontPack", 30),
  name: "Test pack",
  slug: { name: "test-pack" },
  visibility: "UNLISTED",
  totalStyles: 3,
  members: [
    { __typename: "FontStyle", id: styleB.id },
    { __typename: "FontCollection", id: standalone.id },
    { __typename: "FontStyle", id: styleA.id },
  ],
};

type Catalog = { collections: typeof family[]; licenses: typeof license[] };

function catalogResponse(catalog: Catalog) {
  return {
    data: {
      viewer: {
        fontCollections: { edges: catalog.collections.map((node) => ({ node })) },
        licenses: catalog.licenses,
      },
    },
  };
}

interface FontdueBehaviour {
  catalog?: Catalog | { errors: { message: string }[] } | { status: number };
  packs?:
    | { packs: typeof pack[]; supportsUnlisted?: boolean }
    | { errors: { message: string }[] }
    | { status: number };
}

/** Mock fetch that answers the catalog query and the pack query separately */
function mockFontdue(behaviour: FontdueBehaviour) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    const { query } = JSON.parse(init.body) as { query: string };
    calls.push(query);
    const isPacks = query.includes("fontPacks");
    const spec = isPacks ? behaviour.packs : behaviour.catalog;

    if (!spec) return jsonResponse({ errors: [{ message: 'Cannot query field "fontPacks" on type "Viewer"' }] });
    if ("status" in spec) return new Response("upstream error", { status: spec.status, statusText: "Bad Gateway" });
    if ("errors" in spec) return jsonResponse({ errors: spec.errors });
    if (isPacks) {
      const packSpec = spec as { packs: typeof pack[]; supportsUnlisted?: boolean };
      if (query.includes("includeUnlisted") && packSpec.supportsUnlisted === false) {
        return jsonResponse({ errors: [{ message: 'Unknown argument "includeUnlisted" on field "fontPacks" of type "Viewer".' }] });
      }
      return jsonResponse({ data: { viewer: { fontPacks: { edges: packSpec.packs.map((node) => ({ node })) } } } });
    }
    return jsonResponse(catalogResponse(spec as Catalog));
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const fullCatalog: Catalog = { collections: [superfamily, family, standalone], licenses: [license] };

async function run(sanity: FakeSanity, options: Partial<Parameters<typeof syncFontdueData>[0]> = {}) {
  return syncFontdueData({ sanityClient: sanity.asClient(), fontdueUrl: "https://example.fontdue.com", ...options });
}

/** A dataset as a previous run with the same options would have left it */
async function seededSanity(options: Partial<Parameters<typeof syncFontdueData>[0]> = {}, behaviour: FontdueBehaviour = { catalog: fullCatalog, packs: { packs: [pack] } }) {
  const sanity = new FakeSanity();
  mockFontdue(behaviour);
  await run(sanity, options);
  sanity.log = [];
  sanity.queries = [];
  return sanity;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// --- Compatibility ------------------------------------------------------------

describe("without new options", () => {
  it("issues the 0.3.1 catalog query and nothing else", async () => {
    const sanity = new FakeSanity();
    const { calls } = mockFontdue({ catalog: fullCatalog });
    const result = await run(sanity);

    expect(calls).toEqual([SYNC_QUERY]);
    expect(result.packs).toBeUndefined();
    expect(result.packsSkipped).toBeUndefined();
    expect(result.collections).toEqual({ created: 3, updated: 0, deleted: 0, skippedUnchanged: 0 });
    expect(result.styles).toEqual({ created: 3, updated: 0, deleted: 0, skippedUnchanged: 0 });
    expect(result.licenses).toEqual({ created: 1, updated: 0, deleted: 0, skippedUnchanged: 0 });
    expect(sanity.ofType("fontduePack")).toEqual([]);
    expect(sanity.get("fontdueSyncStatus")).not.toHaveProperty("packs");
  });

  it("writes nothing on a second identical run", async () => {
    const sanity = await seededSanity();
    mockFontdue({ catalog: fullCatalog });
    await run(sanity);
    expect(sanity.log).toEqual([expect.objectContaining({ kind: "createOrReplace", id: "fontdueSyncStatus" })]);
  });

  it("hard-deletes an orphan and strips the editorial reference, as 0.3.1 did", async () => {
    const sanity = await seededSanity();
    sanity.seed({ _id: "typefacePage-12", _type: "typefacePage", fontdueCollection: { _type: "reference", _ref: "fontdueCollection-12" } });
    mockFontdue({ catalog: { collections: [superfamily, family], licenses: [license] } });

    const result = await run(sanity);

    expect(result.collections.deleted).toBe(1);
    expect(sanity.get("fontdueCollection-12")).toBeUndefined();
    expect(sanity.get("fontdueStyle-3")).toBeUndefined();
    expect(sanity.get("typefacePage-12")).not.toHaveProperty("fontdueCollection");
  });
});

// --- Hardening ----------------------------------------------------------------

describe("hardening", () => {
  it("throws before any write when the catalog response carries errors", async () => {
    const sanity = await seededSanity();
    mockFontdue({ catalog: { errors: [{ message: "internal error" }] } });
    await expect(run(sanity)).rejects.toThrow(/internal error/);
    expect(sanity.log).toEqual([]);
  });

  it("throws before any write on a non-2xx response", async () => {
    const sanity = await seededSanity();
    mockFontdue({ catalog: { status: 502 } });
    await expect(run(sanity)).rejects.toThrow(/502/);
    expect(sanity.log).toEqual([]);
  });

  it("refuses to empty a populated dataset unless allowEmptyCatalog is set", async () => {
    const sanity = await seededSanity();
    mockFontdue({ catalog: { collections: [], licenses: [] } });
    await expect(run(sanity)).rejects.toThrow(/allowEmptyCatalog/);
    expect(sanity.log).toEqual([]);

    const result = await run(sanity, { allowEmptyCatalog: true });
    expect(result.collections.deleted).toBe(3);
    expect(sanity.ofType("fontdueCollection")).toEqual([]);
  });
});

// --- Font packs -----------------------------------------------------------------

describe("syncPacks", () => {
  it("mirrors a pack with members in Fontdue's order, dropping unsynced targets", async () => {
    const sanity = new FakeSanity();
    const hiddenStyle = { __typename: "FontStyle", id: gid("FontStyle", 99) };
    const { calls } = mockFontdue({ catalog: fullCatalog, packs: { packs: [{ ...pack, members: [...pack.members, hiddenStyle] }] } });

    const result = await run(sanity, { syncPacks: true });

    expect(calls).toEqual([SYNC_QUERY, PACKS_QUERY_WITH_UNLISTED]);
    expect(result.packs).toEqual({ created: 1, updated: 0, deleted: 0, skippedUnchanged: 0 });
    expect(sanity.get("fontduePack-30")).toEqual({
      _id: "fontduePack-30",
      _type: "fontduePack",
      fontdueId: pack.id,
      name: "Test pack",
      slug: "test-pack",
      visibility: "unlisted",
      totalStyles: 3,
      members: [
        { _type: "reference", _ref: "fontdueStyle-2", _key: "fontdueStyle-2" },
        { _type: "reference", _ref: "fontdueCollection-12", _key: "fontdueCollection-12" },
        { _type: "reference", _ref: "fontdueStyle-1", _key: "fontdueStyle-1" },
      ],
    });
    expect(sanity.get("fontdueSyncStatus")?.packs).toEqual(result.packs);
  });

  it("writes nothing for an unchanged pack and rewrites it when only the order changes", async () => {
    const sanity = await seededSanity({ syncPacks: true });
    mockFontdue({ catalog: fullCatalog, packs: { packs: [pack] } });
    const unchanged = await run(sanity, { syncPacks: true });
    expect(unchanged.packs).toEqual({ created: 0, updated: 0, deleted: 0, skippedUnchanged: 1 });
    expect(sanity.mutationsOf("createOrReplace").map((m) => m.id)).toEqual(["fontdueSyncStatus"]);

    sanity.log = [];
    mockFontdue({ catalog: fullCatalog, packs: { packs: [{ ...pack, members: [...pack.members].reverse() }] } });
    const reordered = await run(sanity, { syncPacks: true });
    expect(reordered.packs?.updated).toBe(1);
    expect(sanity.get("fontduePack-30")?.members.map((m: { _ref: string }) => m._ref)).toEqual([
      "fontdueStyle-1",
      "fontdueCollection-12",
      "fontdueStyle-2",
    ]);
  });

  it("falls back to visible-only packs on a backend without includeUnlisted", async () => {
    const sanity = new FakeSanity();
    const { calls } = mockFontdue({ catalog: fullCatalog, packs: { packs: [pack], supportsUnlisted: false } });
    const result = await run(sanity, { syncPacks: true });
    expect(calls).toEqual([SYNC_QUERY, PACKS_QUERY_WITH_UNLISTED, PACKS_QUERY]);
    expect(result.packs?.created).toBe(1);
  });

  it("skips the pack phase on a backend without font packs and leaves existing packs untouched", async () => {
    const sanity = await seededSanity({ syncPacks: true });
    mockFontdue({ catalog: fullCatalog });
    const result = await run(sanity, { syncPacks: true });
    expect(result.packs).toBeUndefined();
    expect(result.packsSkipped).toBe("unsupported");
    expect(result.status).toBe("success");
    expect(sanity.get("fontduePack-30")).toBeDefined();
    expect(sanity.get("fontdueSyncStatus")?.packsSkipped).toBe("unsupported");
  });

  it("skips the pack phase on a failed pack request without orphaning packs", async () => {
    const sanity = await seededSanity({ syncPacks: true });
    mockFontdue({ catalog: fullCatalog, packs: { status: 502 } });
    const result = await run(sanity, { syncPacks: true });
    expect(result.packsSkipped).toMatch(/502/);
    expect(sanity.get("fontduePack-30")).toBeDefined();
    expect(sanity.mutationsOf("delete")).toEqual([]);
  });

  it("deletes a pack that left Fontdue and strips the editorial reference under the delete strategy", async () => {
    const sanity = await seededSanity({ syncPacks: true });
    sanity.seed({ _id: "fontPack-basic", _type: "fontPack", fontduePack: { _type: "reference", _ref: "fontduePack-30" } });
    mockFontdue({ catalog: fullCatalog, packs: { packs: [] } });
    const result = await run(sanity, { syncPacks: true });
    expect(result.packs?.deleted).toBe(1);
    expect(sanity.get("fontduePack-30")).toBeUndefined();
    expect(sanity.get("fontPack-basic")).not.toHaveProperty("fontduePack");
  });

  it("drops a deleted style from a pack's members before deleting the style", async () => {
    const sanity = await seededSanity({ syncPacks: true });
    const familyWithoutBold = { ...family, fontStyles: [styleA] };
    mockFontdue({ catalog: { collections: [superfamily, familyWithoutBold, standalone], licenses: [license] }, packs: { packs: [{ ...pack, members: pack.members.filter((m) => m.id !== styleB.id) }] } });
    const result = await run(sanity, { syncPacks: true });
    expect(result.styles.deleted).toBe(1);
    expect(sanity.get("fontdueStyle-2")).toBeUndefined();
    expect(sanity.get("fontduePack-30")?.members.map((m: { _ref: string }) => m._ref)).toEqual(["fontdueCollection-12", "fontdueStyle-1"]);
  });
});

// --- Soft delete ----------------------------------------------------------------

describe('orphanStrategy: "softDelete"', () => {
  const soft = { syncPacks: true, orphanStrategy: "softDelete" as const };

  it("flags a referenced collection instead of deleting it, and clears the flag when it returns", async () => {
    const sanity = await seededSanity(soft);
    sanity.seed({ _id: "typefacePage-12", _type: "typefacePage", fontdueCollection: { _type: "reference", _ref: "fontdueCollection-12" } });

    mockFontdue({ catalog: { collections: [superfamily, family], licenses: [license] }, packs: { packs: [{ ...pack, members: pack.members.filter((m) => m.id !== standalone.id) }] } });
    const removed = await run(sanity, soft);

    expect(removed.collections.deleted).toBe(1);
    expect(sanity.get("fontdueCollection-12")).toMatchObject({ isDeleted: true, deletedAt: "2026-09-25T12:00:00.000Z" });
    expect(sanity.get("typefacePage-12")?.fontdueCollection?._ref).toBe("fontdueCollection-12");
    // its style had nothing but synced documents pointing at it: gone
    expect(sanity.get("fontdueStyle-3")).toBeUndefined();
    expect(sanity.get("fontdueCollection-12")?.styles ?? []).toEqual([]);

    // steady state: the flag is not rewritten
    sanity.log = [];
    await run(sanity, soft);
    expect(sanity.mutationsOf("patch")).toEqual([]);

    // back in Fontdue: rewritten without the flag
    mockFontdue({ catalog: fullCatalog, packs: { packs: [pack] } });
    const restored = await run(sanity, soft);
    expect(restored.collections.updated).toBe(1);
    expect(sanity.get("fontdueCollection-12")).not.toHaveProperty("isDeleted");
  });

  it("flags a referenced pack and hard-deletes an unreferenced one", async () => {
    const sanity = await seededSanity(soft, { catalog: fullCatalog, packs: { packs: [pack, { ...pack, id: gid("FontPack", 31), name: "Other", slug: { name: "other" } }] } });
    sanity.seed({ _id: "fontPack-basic", _type: "fontPack", fontduePack: { _type: "reference", _ref: "fontduePack-30" } });

    mockFontdue({ catalog: fullCatalog, packs: { packs: [] } });
    const result = await run(sanity, soft);

    expect(result.packs?.deleted).toBe(2);
    expect(sanity.get("fontduePack-30")).toMatchObject({ isDeleted: true });
    expect(sanity.get("fontPack-basic")?.fontduePack?._ref).toBe("fontduePack-30");
    expect(sanity.get("fontduePack-31")).toBeUndefined();
  });

  it("still hard-deletes an orphan referenced only by other synced documents", async () => {
    const sanity = await seededSanity(soft);
    mockFontdue({ catalog: { collections: [superfamily, family], licenses: [license] }, packs: { packs: [pack] } });
    await run(sanity, soft);
    // standalone was a pack member (a synced reference) and nothing else
    expect(sanity.get("fontdueCollection-12")).toBeUndefined();
    expect(sanity.get("fontduePack-30")?.members.map((m: { _ref: string }) => m._ref)).toEqual(["fontdueStyle-2", "fontdueStyle-1"]);
  });
});

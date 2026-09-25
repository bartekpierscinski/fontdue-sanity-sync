/**
 * An in-memory stand-in for the parts of `@sanity/client` the sync uses:
 * `fetch` (a handful of GROQ shapes), `transaction()` with
 * createOrReplace / patch / delete, and `createOrReplace`. Every mutation is
 * applied to the store so later reads see it, and logged so tests can
 * assert exactly what was written.
 */
import type { SanityClient } from "@sanity/client";

type Doc = Record<string, any> & { _id: string; _type: string };

export interface LoggedMutation {
  kind: "createOrReplace" | "patch" | "delete";
  id: string;
  doc?: Doc;
  set?: Record<string, unknown>;
  unset?: string[];
  visibility?: string;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function referencesId(value: unknown, id: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((v) => referencesId(v, id));
  const record = value as Record<string, unknown>;
  if (record._ref === id) return true;
  return Object.values(record).some((v) => referencesId(v, id));
}

function setPath(target: Record<string, any>, path: string, value: unknown) {
  // Supports "field" and "field[3].sub" as cleanupExternalReferences emits
  const segments = path.match(/[^.[\]]+/g) ?? [];
  let node = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = /^\d+$/.test(segments[i]) ? Number(segments[i]) : segments[i];
    if (node[key] == null) node[key] = /^\d+$/.test(segments[i + 1]) ? [] : {};
    node = node[key];
  }
  const last = segments[segments.length - 1];
  node[/^\d+$/.test(last) ? Number(last) : last] = value;
}

function unsetPath(target: Record<string, any>, path: string) {
  const segments = path.match(/[^.[\]]+/g) ?? [];
  let node = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = /^\d+$/.test(segments[i]) ? Number(segments[i]) : segments[i];
    if (node[key] == null) return;
    node = node[key];
  }
  const last = segments[segments.length - 1];
  if (Array.isArray(node)) node.splice(Number(last), 1);
  else delete node[last];
}

export class FakeSanity {
  docs = new Map<string, Doc>();
  log: LoggedMutation[] = [];
  queries: string[] = [];

  constructor(seed: Doc[] = []) {
    for (const doc of seed) this.docs.set(doc._id, clone(doc));
  }

  seed(doc: Doc) {
    this.docs.set(doc._id, clone(doc));
  }

  get(id: string): Doc | undefined {
    const doc = this.docs.get(id);
    return doc ? clone(doc) : undefined;
  }

  ofType(type: string): Doc[] {
    return Array.from(this.docs.values())
      .filter((d) => d._type === type)
      .map(clone);
  }

  mutationsOf(kind: LoggedMutation["kind"]): LoggedMutation[] {
    return this.log.filter((m) => m.kind === kind);
  }

  /** The GROQ shapes syncFontdueData and cleanupExternalReferences issue */
  async fetch(query: string, params: Record<string, any> = {}): Promise<any> {
    this.queries.push(query);
    const typeMatch = query.match(/^\s*\*\[_type == "([a-zA-Z]+)"\]/);
    if (typeMatch) return this.ofType(typeMatch[1]);

    if (query.includes("references($ids) && !(_id in $ids)")) {
      const ids: string[] = params.ids;
      return Array.from(this.docs.values())
        .filter((d) => !ids.includes(d._id) && ids.some((id) => referencesId(d, id)))
        .map(clone);
    }

    if (query.includes('"referenced": count(*[references(^._id)')) {
      const ids: string[] = params.ids;
      const syncedTypes: string[] = params.syncedTypes;
      return ids
        .filter((id) => this.docs.has(id))
        .map((id) => ({
          _id: id,
          referenced: Array.from(this.docs.values()).some(
            (d) => d._id !== id && !syncedTypes.includes(d._type) && referencesId(d, id),
          ),
        }));
    }

    throw new Error(`FakeSanity: unsupported query ${query}`);
  }

  transaction() {
    const ops: LoggedMutation[] = [];
    const self = this;
    const tx = {
      createOrReplace(doc: Doc) {
        ops.push({ kind: "createOrReplace", id: doc._id, doc: clone(doc) });
        return tx;
      },
      patch(id: string, build: (p: any) => any) {
        const op: LoggedMutation = { kind: "patch", id };
        const builder = {
          set(values: Record<string, unknown>) {
            op.set = { ...(op.set ?? {}), ...values };
            return builder;
          },
          unset(paths: string[]) {
            op.unset = [...(op.unset ?? []), ...paths];
            return builder;
          },
        };
        build(builder);
        ops.push(op);
        return tx;
      },
      delete(id: string) {
        ops.push({ kind: "delete", id });
        return tx;
      },
      async commit(options?: { visibility?: string }) {
        for (const op of ops) self.apply({ ...op, visibility: options?.visibility });
        return { transactionId: "fake" };
      },
    };
    return tx;
  }

  async createOrReplace(doc: Doc) {
    this.apply({ kind: "createOrReplace", id: doc._id, doc: clone(doc) });
    return doc;
  }

  private apply(op: LoggedMutation) {
    this.log.push(op);
    if (op.kind === "createOrReplace" && op.doc) {
      this.docs.set(op.id, clone(op.doc));
    } else if (op.kind === "delete") {
      // Sanity refuses to delete a document another one still references
      for (const other of this.docs.values()) {
        if (other._id !== op.id && referencesId(other, op.id)) {
          throw new Error(
            `Document "${op.id}" cannot be deleted as there are references to it from "${other._id}"`,
          );
        }
      }
      this.docs.delete(op.id);
    } else if (op.kind === "patch") {
      const doc = this.docs.get(op.id);
      if (!doc) throw new Error(`FakeSanity: patch of missing document ${op.id}`);
      for (const [path, value] of Object.entries(op.set ?? {})) setPath(doc, path, clone(value));
      for (const path of op.unset ?? []) unsetPath(doc, path);
    }
  }

  asClient(): SanityClient {
    return this as unknown as SanityClient;
  }
}

/** Base64 global id the way Fontdue encodes them, e.g. FontCollection:12 */
export function gid(type: string, id: number | string): string {
  return Buffer.from(`${type}:${id}`).toString("base64");
}

import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./tenancy";

/**
 * The assistant's docs index (0504). Platform reference data, not tenant data: the system
 * connection writes and reads it. `search` is a generated tsvector column (title A, heading and
 * terms B, body C, notes D) that only raw SQL reads, so it is not declared here.
 */
export const assistantDocChunks = pgTable("assistant_doc_chunks", {
  id: uuid("id")
    .default(sql`uuid_v7()`)
    .primaryKey(),
  source: text("source").notNull(), // help | api | engine | ui | code
  path: text("path").notNull(),
  url: text("url"),
  title: text("title").notNull(),
  heading: text("heading"),
  body: text("body").notNull(),
  /** Extra search words: split identifiers, screen labels (0506). */
  terms: text("terms"),
  /** Search notes for a help section (0509): its context and the words people use for it. */
  notes: text("notes"),
  /** The `assistant_doc_vectors` row holding this section's embedding (0510). */
  embedHash: text("embed_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** One row: the hash of the content the index was last built from. */
export const assistantDocIndex = pgTable("assistant_doc_index", {
  id: smallint("id").primaryKey(),
  contentHash: text("content_hash").notNull(),
  chunks: integer("chunks").notNull(),
  indexedAt: timestamp("indexed_at", { withTimezone: true }).defaultNow().notNull(),
});

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

/** Section embeddings (0510), keyed by a hash of the model and the embedded text. */
export const assistantDocVectors = pgTable("assistant_doc_vectors", {
  hash: text("hash").primaryKey(),
  model: text("model").notNull(),
  dims: integer("dims").notNull(),
  /** float32, little-endian. */
  vector: bytea("vector").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Embedding calls on the platform key (0511): one row per index run (no organization) and one
 * per search query (the asking organization, else none). Never counts toward an allowance.
 */
export const assistantEmbeddingUsage = pgTable(
  "assistant_embedding_usage",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    kind: text("kind").notNull(), // index | query
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    /** Texts embedded: sections in an index run, 1 for a query. */
    inputs: integer("inputs").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    /** USD minor units × 10^12, from the model price list; null when the model is not priced. */
    costFixed12: numeric("cost_fixed12", { precision: 38, scale: 0 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("assistant_embedding_usage_created_idx").on(t.createdAt),
    index("assistant_embedding_usage_org_created_idx").on(t.organizationId, t.createdAt),
  ],
);

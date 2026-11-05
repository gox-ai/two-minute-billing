/**
 * Run one SQL file against DATABASE_URL as a single transaction.
 *
 *   pnpm tsx scripts/lib/apply-sql.ts scripts/sql/system-role.sql
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import postgres from "postgres";

const file = process.argv[2];
if (!file || !process.env.DATABASE_URL) {
  console.error("usage: DATABASE_URL=… tsx scripts/lib/apply-sql.ts <file.sql>");
  process.exit(2);
}
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
try {
  await sql.begin((tx) => tx.unsafe(readFileSync(file, "utf8")));
  console.log(`applied ${file}`);
} finally {
  await sql.end({ timeout: 5 });
}

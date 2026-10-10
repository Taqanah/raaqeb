/** drizzle-kit for the Postgres dialect: `bun run db:generate`. Runs on Bun through bunfig.toml. */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  // Raaqeb's tables, the migration record included, live in one schema (public).
  migrations: { schema: "public" },
  out: "./src/server/storage/migrations/postgres",
  schema: "./src/server/storage/schema/postgres.ts",
});

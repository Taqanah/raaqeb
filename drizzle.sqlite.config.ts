/** drizzle-kit for the SQLite dialect: `bun run db:generate`. Runs on Bun through bunfig.toml. */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  out: "./src/server/storage/migrations/sqlite",
  schema: "./src/server/storage/schema/sqlite.ts",
});

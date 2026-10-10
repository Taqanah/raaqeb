/**
 * `bun run db:generate <name>`: one drizzle-kit migration per dialect from the
 * two schema files, under Bun through bunfig.toml. The change
 * counter's seed row is a hand-written data step added to the first migration.
 */

const configs = ["drizzle.sqlite.config.ts", "drizzle.postgres.config.ts"];

const [, , name] = Bun.argv;
if (!(name && /^[a-z0-9_]+$/.test(name))) {
  process.stderr.write(
    "usage: bun run db:generate <name>  (lowercase letters, digits and underscores)\n"
  );
  process.exit(2);
}
for (const config of configs) {
  const run = Bun.spawnSync(
    [
      "bun",
      "--bun",
      "drizzle-kit",
      "generate",
      "--config",
      config,
      "--name",
      name,
    ],
    { cwd: `${import.meta.dir}/..`, stdio: ["inherit", "inherit", "inherit"] }
  );
  if (run.exitCode !== 0) {
    process.exit(run.exitCode);
  }
}

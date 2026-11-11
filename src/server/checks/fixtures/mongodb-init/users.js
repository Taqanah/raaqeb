// The users the MongoDB monitor's tests sign in as, beside the root user the
// image creates: one per SCRAM mechanism, and the two that test SASLprep, made
// with the raw name and password so the client's normalization is what is tested.
// biome-ignore lint/correctness/noUndeclaredVariables: mongosh runs this file and provides db
const admin = db.getSiblingDB("admin");
for (const [user, pwd, mechanisms] of [
  ["sha1", "sha1", ["SCRAM-SHA-1"]],
  ["sha256", "sha256", ["SCRAM-SHA-256"]],
  ["IX", "IX", ["SCRAM-SHA-256"]],
  ["Ⅸ", "Ⅳ", ["SCRAM-SHA-256"]],
]) {
  admin.createUser({ user, pwd, roles: ["root"], mechanisms });
}
// A user that may only run commands that need no privilege, so a command it is not allowed is refused.
admin.createUser({ user: "nobody", pwd: "nobody", roles: [] });

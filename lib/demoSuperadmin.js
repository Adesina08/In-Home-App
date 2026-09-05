const bcrypt = require("bcryptjs");
const store = require("./store");

const DEMO_ADMIN_EMAIL = "admin@inicio.demo";
const DEMO_SUPERADMIN_EMAIL = "superadmin@inicio.demo";
const DEMO_PASSWORD = "Demo1234!";

/**
 * Keep the known demo Superadmin credential confined to the seeded/sample
 * environment. We identify that environment by the presence of the seeded
 * demo Admin account rather than by NODE_ENV or database driver, because the
 * sample can run against either the local JSON store or a managed MongoDB.
 *
 * A real production database that does not contain admin@inicio.demo will
 * never receive this known credential.
 */
async function ensureDemoSuperadmin() {
  const demoAdmin = await store.findOne("users", { email: DEMO_ADMIN_EMAIL });
  if (!demoAdmin) return { created: false, reason: "not_demo_database" };

  const existing = await store.findOne("users", { email: DEMO_SUPERADMIN_EMAIL });
  if (existing) return { created: false, reason: "already_exists", id: existing.id };

  const passwordHash = bcrypt.hashSync(DEMO_PASSWORD, 10);
  const { id } = await store.insert("users", {
    name: "Superadmin User",
    email: DEMO_SUPERADMIN_EMAIL,
    password_hash: passwordHash,
    role: "superadmin",
    study_id: null,
  });

  console.log(`Demo Superadmin ensured: ${DEMO_SUPERADMIN_EMAIL}`);
  return { created: true, id };
}

module.exports = {
  ensureDemoSuperadmin,
  DEMO_SUPERADMIN_EMAIL,
  DEMO_PASSWORD,
};

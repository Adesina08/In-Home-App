const db = require("./db");

function logAudit(actor, action, entity, entityId, detail) {
  db.prepare(
    `INSERT INTO audit_log (actor, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?)`
  ).run(actor || "system", action, entity, entityId || null, detail ? JSON.stringify(detail) : null);
}

module.exports = { logAudit };

const store = require("./store");

// Fire-and-forget: an audit write must never be the reason a request fails,
// and every caller treats it that way (none of them await it). Returning the
// promise anyway lets a caller that does care -- the tests -- wait for it.
function logAudit(actor, action, entity, entityId, detail) {
  return store
    .insert("audit_log", {
      actor: actor || "system",
      action,
      entity,
      entity_id: entityId || null,
      detail: detail ? JSON.stringify(detail) : null,
    })
    .catch((e) => {
      console.error("Audit write failed:", e.message);
    });
}

module.exports = { logAudit };

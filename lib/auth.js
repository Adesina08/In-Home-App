function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect("/login");

    // Superadmin is the platform-level role. It inherits every staff portal
    // permission rather than needing to be added manually to each individual
    // requireRole("admin"), requireRole("research"), etc. guard. This keeps
    // the hierarchy consistent as new staff-only routes are added later.
    if (req.session.user.role === "superadmin") return next();

    if (!roles.includes(req.session.user.role)) {
      return res.status(403).render("error", {
        message: "You do not have access to this section.",
        user: req.session.user,
      });
    }
    next();
  };
}

module.exports = { requireLogin, requireRole };

// Light/dark switch.
//
// The theme is applied before first paint by an inline script in the header;
// this only handles changing it. Both are needed: applying here would mean a
// white flash on every load of a dark screen.
(function () {
  var KEY = "inicio-theme";

  function current() {
    return document.documentElement.classList.contains("dark") ? "dark" : "light";
  }

  function apply(theme) {
    document.documentElement.classList.toggle("dark", theme === "dark");
    try { localStorage.setItem(KEY, theme); } catch (e) {}
    // Keeps the browser's own UI (form controls, scrollbars) in step; without
    // it a dark page renders light native dropdowns.
    document.documentElement.style.colorScheme = theme;
    document.querySelectorAll("[data-theme-toggle]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(theme === "dark"));
      var l = b.querySelector("[data-theme-label]");
      if (l) l.textContent = theme === "dark" ? "Light mode" : "Dark mode";
    });
  }

  document.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-theme-toggle]");
    if (!btn) return;
    apply(current() === "dark" ? "light" : "dark");
  });

  apply(current());
})();

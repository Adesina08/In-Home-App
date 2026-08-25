// Live side of question-text piping (see lib/piping.js for the server side).
// A {q:CODE} token in a question's wording renders as
//   <span class="pipe-answer" data-pipe-q="CODE" data-pipe-fallback="…">…</span>
// and this keeps every one of those in sync with what the respondent has
// actually answered so far, as they answer it -- so a later question can read
// "How much of <the brand they just named> did you drink?" without the
// respondent having to re-read their own earlier answer.
//
// Falls back to the placeholder whenever the source answer is cleared, so a
// sentence never silently keeps a stale value from an answer that's since
// been changed.
//
// Runs on both the respondent diary form and the admin live preview, which
// name their inputs differently (the real form uses name="q_<id>"; the
// preview only tags them data-qid="<id>"), so field lookup tries both rather
// than assuming either page's convention.
(function () {
  var spans = document.querySelectorAll("[data-pipe-q]");
  if (!spans.length) return; // no piped questions on this page -- nothing to watch

  // Scope to whatever container actually holds the questions, rather than
  // assuming a particular form id.
  var scope = spans[0].closest("form") || document;

  // code -> question id, published by the page (form fields are keyed by
  // question id, but authors write pipes against the readable code).
  var CODE_TO_QID = {};
  try {
    var mapEl = document.getElementById("pipe-code-map");
    if (mapEl) CODE_TO_QID = JSON.parse(mapEl.textContent) || {};
  } catch (e) {
    CODE_TO_QID = {};
  }

  function fieldsForQid(qid) {
    var found = scope.querySelectorAll(
      '[name="q_' + qid + '"], [name="q_' + qid + '[]"], [data-qid="' + qid + '"]'
    );
    // Only real inputs -- the preview also tags non-input wrappers with data-qid.
    var out = [];
    for (var i = 0; i < found.length; i++) {
      var tag = found[i].tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") out.push(found[i]);
    }
    return out;
  }

  function valueForCode(code) {
    var qid = CODE_TO_QID[code];
    if (!qid) return "";
    var els = fieldsForQid(qid);
    if (!els.length) return "";

    var type = els[0].type;
    if (type === "radio") {
      for (var i = 0; i < els.length; i++) if (els[i].checked) return els[i].value;
      return "";
    }
    if (type === "checkbox") {
      var picked = [];
      for (var j = 0; j < els.length; j++) if (els[j].checked) picked.push(els[j].value);
      // Read naturally in a sentence: "A, B and C" rather than "A, B, C".
      if (picked.length <= 1) return picked[0] || "";
      return picked.slice(0, -1).join(", ") + " and " + picked[picked.length - 1];
    }
    return els[0].value || "";
  }

  function refresh() {
    for (var i = 0; i < spans.length; i++) {
      var span = spans[i];
      var val = valueForCode(span.getAttribute("data-pipe-q"));
      var fallback = span.getAttribute("data-pipe-fallback") || "…";
      var next = val && String(val).trim() !== "" ? val : fallback;
      if (span.textContent !== next) span.textContent = next;
    }
  }

  var listenOn = scope === document ? document : scope;
  listenOn.addEventListener("input", refresh);
  listenOn.addEventListener("change", refresh);
  refresh(); // prefilled / draft-restored answers should show immediately
})();

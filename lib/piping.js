// Question-text piping: substitute respondent/study values (and earlier
// answers) into later question wording, so a study can ask
// "Which {q:BRAND} pack did you buy, {respondent_name}?" instead of a
// generic sentence. Spec 3.3 ("Pipe respondent/study values into later
// questions where required").
//
// Two kinds of token, resolved in two different places on purpose:
//
//   {respondent_name} / {study_name} / ...  -- known before the page renders,
//       so they're substituted server-side into the final text.
//
//   {q:CODE}  -- the answer to an EARLIER question in the same diary entry,
//       which the respondent hasn't typed yet when the page is served. These
//       become a <span data-pipe-q="CODE"> that public/js/piping.js keeps in
//       sync as the form is filled in. Rendering them server-side would only
//       ever show the fallback.
//
// Unknown tokens are left exactly as written rather than blanked out: a
// typo'd {responent_name} showing through to a respondent is a visible bug an
// admin can spot and fix, whereas silently deleting it hides the mistake.

const FIELD_TOKENS = {
  respondent_name: (ctx) => ctx.respondent && ctx.respondent.name,
  respondent_code: (ctx) => ctx.respondent && ctx.respondent.respondent_code,
  study_name: (ctx) => ctx.study && ctx.study.name,
  study_market: (ctx) => ctx.study && ctx.study.market,
  study_category: (ctx) => ctx.study && ctx.study.category,
};

// Default shown while an {q:CODE} answer hasn't been given yet (and for a
// field token that resolved to nothing) -- deliberately neutral so a
// half-filled sentence still reads as a sentence.
const EMPTY_FALLBACK = "…";

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Matches {token} or {q:CODE}, optionally with a |fallback:
//   {respondent_name}  {respondent_name|there}  {q:BRAND}  {q:BRAND|that brand}
const TOKEN_RE = /\{\s*([a-z_]+)\s*(?::\s*([^}|]+?)\s*)?(?:\|\s*([^}]*?)\s*)?\}/gi;

/**
 * Render question text containing pipe tokens to HTML.
 * Returns an HTML string -- callers must output it with <%- %>, not <%= %>.
 *
 * IMPORTANT: the literal (non-token) parts of the text are escaped here too,
 * not just the substituted values. Callers switched from <%= text %> to
 * <%- renderPipeHtml(text) %>, which turns off EJS's own escaping -- so if
 * this returned the author's text verbatim, any markup typed into a question
 * (or carried in on an uploaded questionnaire, which can come from a client
 * as a spreadsheet/doc) would execute in the respondent's browser. The only
 * HTML that may appear in the output is the <span> this function generates.
 */
function renderPipeHtml(text, ctx = {}) {
  if (text == null) return "";
  const source = String(text);
  let out = "";
  let lastIndex = 0;
  TOKEN_RE.lastIndex = 0;

  let match;
  while ((match = TOKEN_RE.exec(source)) !== null) {
    const [raw, name, arg, fallback] = match;
    out += escapeHtml(source.slice(lastIndex, match.index)); // literal text between tokens
    lastIndex = match.index + raw.length;

    const key = String(name).toLowerCase();
    const fb = fallback != null && fallback !== "" ? fallback : EMPTY_FALLBACK;

    if (key === "q") {
      // Answer to an earlier question -- filled in client-side, live.
      out += arg
        ? `<span class="pipe-answer" data-pipe-q="${escapeHtml(arg)}" data-pipe-fallback="${escapeHtml(fb)}">${escapeHtml(fb)}</span>`
        : escapeHtml(raw);
      continue;
    }

    const resolver = FIELD_TOKENS[key];
    if (!resolver) {
      out += escapeHtml(raw); // unknown token -- show it, don't hide the typo
      continue;
    }
    const value = resolver(ctx);
    out += escapeHtml(value != null && String(value).trim() !== "" ? value : fb);
  }

  out += escapeHtml(source.slice(lastIndex));
  return out;
}

/** True if the text uses any {q:CODE} token, i.e. the page needs the client-side script. */
function hasAnswerPipes(text) {
  if (text == null) return false;
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(String(text))) !== null) {
    if (String(m[1]).toLowerCase() === "q" && m[2]) return true;
  }
  return false;
}

module.exports = { renderPipeHtml, hasAnswerPipes, FIELD_TOKENS, EMPTY_FALLBACK };

// The study configuration tabs, in the order an admin actually sets a study up.
//
// One list, used twice: by the tab strip at the top of every study page, and
// by the Back/Next buttons at the bottom. Keeping it in one place is the point
// -- two copies would drift the moment a tab is added, and the failure mode is
// a Next button that skips a step nobody then remembers to configure.
//
// The order is the setup order, not an alphabetical or importance order:
// settings first because diary mode and recruitment mode change what the later
// screens offer; questions next; then the consent wording those questions sit
// behind; then the client's KPIs; and only then respondents and their media,
// which are fieldwork rather than configuration.
const STUDY_TABS = [
  { key: "settings", label: "Settings & Thresholds", icon: "cog", short: "Settings" },
  { key: "questionnaire", label: "Questionnaire, Skip Logic & Brands", icon: "clipboard", short: "Questionnaire" },
  { key: "consent", label: "Consent Wording", icon: "shield", short: "Consent" },
  { key: "kpis", label: "Client KPIs", icon: "trend", short: "KPIs" },
  { key: "respondents", label: "Respondents", icon: "users", short: "Respondents" },
  { key: "media", label: "Media Review", icon: "photo", short: "Media" },
];

function studyTabHref(studyId, key) {
  return `/admin/studies/${studyId}${key === "settings" ? "" : `/${key}`}`;
}

/** The tab before and after `key`, or null at either end. */
function studyTabNeighbours(key) {
  const i = STUDY_TABS.findIndex((t) => t.key === key);
  if (i === -1) return { prev: null, next: null, index: -1, total: STUDY_TABS.length };
  return {
    prev: i > 0 ? STUDY_TABS[i - 1] : null,
    next: i < STUDY_TABS.length - 1 ? STUDY_TABS[i + 1] : null,
    index: i,
    total: STUDY_TABS.length,
  };
}

module.exports = { STUDY_TABS, studyTabHref, studyTabNeighbours };

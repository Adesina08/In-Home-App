// The category list a study can be tagged with. A study can sit in more than
// one (a household diary often covers several FMCG categories at once), so
// this is multi-select rather than a single choice.
//
// Stored pipe-delimited in studies.category, matching how multi-select answers
// are stored in responses -- one convention for multi-values across the app
// rather than JSON here and pipes there. No category contains a "|", and the
// list is fixed here rather than free text so two studies can't end up tagged
// "Malt Beverage" and "Malt beverages" and fall out of the same report.
const CATEGORIES = [
  "Noodles",
  "Toothpaste",
  "Edible Oil",
  "Bleach",
  "Toilet Cleaner",
  "Snacks products",
  "Breakfast Cereal",
  "Condiment Mixes",
  "Hair Care",
  "Dry Hair",
  "Malt Beverage",
];

/** Stored value -> array. Tolerates the old single-value strings and commas. */
function parseCategories(stored) {
  if (!stored) return [];
  return String(stored)
    .split(/[|,]/)
    .map((c) => c.trim())
    .filter(Boolean);
}

/** Form input (array or single string) -> the stored pipe-delimited value. */
function toStoredCategories(input) {
  const list = Array.isArray(input) ? input : input ? [input] : [];
  // Keep the canonical order regardless of the order boxes were ticked, and
  // drop anything not on the list -- the form posts values, and a stray one
  // shouldn't become a new de-facto category.
  const picked = CATEGORIES.filter((c) => list.includes(c));
  return picked.length ? picked.join("|") : null;
}

/** Human-readable, for anywhere a category is displayed. */
function formatCategories(stored) {
  const list = parseCategories(stored);
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

module.exports = { CATEGORIES, parseCategories, toStoredCategories, formatCategories };

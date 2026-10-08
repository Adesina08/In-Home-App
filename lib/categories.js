// The category list a study can be tagged with. A study can sit in more than
// one (a household diary often covers several FMCG categories at once), so
// this is multi-select rather than a single choice.
//
// Stored pipe-delimited in studies.category, matching how multi-select answers
// are stored in responses -- one convention for multi-values across the app
// rather than JSON here and pipes there. No category contains a "|", and the
// list is fixed here rather than free text so two studies can't end up tagged
// "Malt Beverage" and "Malt beverages" and fall out of the same report.
// Grouped two levels deep. Only the specific category is ever stored (on a
// study, or on a detection); its group is derived from this table, so the two
// can never disagree. `ai` is the wording the detection model sees where the
// short research label (CSD, RTD, UHT) would be ambiguous to it.
const CATEGORY_GROUPS = [
  { group: "Food", categories: [
    { name: "Instant Noodles" },
    { name: "Pasta", ai: "Pasta (spaghetti, macaroni)" },
    { name: "Edible Oil", ai: "Edible Oil (vegetable, palm or groundnut cooking oil)" },
    { name: "Powdered Milk and creamers" },
    { name: "Sugar" },
    { name: "Evaporated milk" },
    { name: "Breakfast cereal", ai: "Breakfast cereal (cornflakes, oats, custard)" },
    { name: "Cocoa Beverages", ai: "Cocoa Beverages (chocolate malt drink powders)" },
    { name: "Ball Foods", ai: "Ball Foods (swallows: eba/garri, semovita, poundo yam, fufu, amala)" },
    { name: "Rice" },
    { name: "Tea" },
    { name: "Coffee" },
    { name: "Margarine/Spreads" },
    { name: "Mayonnaise" },
    { name: "UHT", ai: "UHT (long-life liquid milk)" },
    { name: "Baking Flour" },
    { name: "Snacks", ai: "Snacks (biscuits, chin chin, plantain chips, crisps)" },
    { name: "Seasoning & Condiments", ai: "Seasoning & Condiments (seasoning cubes, spice mixes, tomato paste)" },
    { name: "Other food" },
  ] },
  { group: "Non Alcoholic", categories: [
    { name: "Water" },
    { name: "CSD", ai: "CSD (carbonated soft drinks: cola, lemon-lime, orange soda)" },
    { name: "Malt drinks", ai: "Malt drinks (non-alcoholic malt)" },
    { name: "Energy Drinks" },
    { name: "Flavoured milk" },
    { name: "Fruit Juices" },
    { name: "Yoghurt drinks" },
  ] },
  { group: "Confectioneries", categories: [
    { name: "Chewing Gums" },
    { name: "Candies" },
    { name: "Chocolates" },
  ] },
  { group: "Alcoholic Beverages", categories: [
    { name: "Gin" },
    { name: "Beer" },
    { name: "Liqueur" },
    { name: "Schnapps" },
    { name: "Rum" },
    { name: "RTD", ai: "RTD (ready-to-drink alcoholic mixes in a can or bottle)" },
    { name: "Whisky" },
    { name: "Vodka" },
    { name: "Brandy & Cognac" },
    { name: "Other alcoholic beverages" },
  ] },
  { group: "Tobacco", categories: [
    { name: "Cigarettes" },
    { name: "Other Tobacco" },
  ] },
  { group: "Household & Personal Care", categories: [
    { name: "Toothpaste" },
    { name: "Bleach" },
    { name: "Toilet Cleaner" },
    { name: "Hair Care" },
    { name: "Dry Hair" },
  ] },
];

const CATEGORIES = CATEGORY_GROUPS.flatMap((g) => g.categories.map((c) => c.name));
const GROUP_OF = new Map(CATEGORY_GROUPS.flatMap((g) => g.categories.map((c) => [c.name, g.group])));
const AI_LABEL = new Map(CATEGORY_GROUPS.flatMap((g) => g.categories.map((c) => [c.name, c.ai || c.name])));

// Names from the earlier flat list. Studies saved before the regrouping still
// carry them, so they are read as the category they became rather than
// silently dropping out of detection and reports.
const RENAMED = {
  "Noodles": "Instant Noodles",
  "Malt Beverage": "Malt drinks",
  "Breakfast Cereal": "Breakfast cereal",
  "Snacks products": "Snacks",
  "Condiment Mixes": "Seasoning & Condiments",
};

/** Any stored spelling (old or current) -> the current category name. */
function canonicalCategory(name) {
  const value = String(name || "").trim();
  return RENAMED[value] || value;
}

// ---------- Custom categories ----------
// The built-in list can never be exhaustive, so whoever sets a study up can
// add their own (studies.custom_categories: [{ name, group, description }]).
// A custom name is stored in studies.category alongside the ticked built-ins,
// so detection, reports and filters treat it exactly like one of them; this
// array only adds the group and the hint the detection model reads.
const CUSTOM_GROUPS = [...CATEGORY_GROUPS.map((g) => g.group), "Other"];
const MAX_CUSTOM = 30;

const comparable = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/s$/, "");

/** The built-in a typed name really means ("malt drink" -> "Malt drinks"), or null. */
function builtInMatch(name) {
  const wanted = comparable(canonicalCategory(name));
  if (!wanted) return null;
  return CATEGORIES.find((c) => comparable(c) === wanted) || null;
}

function customCategoriesOf(study) {
  return Array.isArray(study && study.custom_categories) ? study.custom_categories : [];
}

/**
 * Form rows -> clean custom categories. A name that is really a built-in is
 * not kept as a custom near-duplicate (two studies must not report "Malt
 * drinks" and "malt drink" separately); it is returned in `builtIns` so the
 * caller ticks the built-in instead.
 */
function normalizeCustomCategories(names, groups, descriptions) {
  const list = [].concat(names ?? []), groupList = [].concat(groups ?? []), descList = [].concat(descriptions ?? []);
  const customs = [], builtIns = [];
  list.forEach((raw, i) => {
    const name = String(raw || "").replace(/[|,]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!name) return;
    const builtIn = builtInMatch(name);
    if (builtIn) { if (!builtIns.includes(builtIn)) builtIns.push(builtIn); return; }
    if (customs.some((c) => comparable(c.name) === comparable(name)) || customs.length >= MAX_CUSTOM) return;
    const group = CUSTOM_GROUPS.includes(groupList[i]) ? groupList[i] : "Other";
    const description = String(descList[i] || "").replace(/\s+/g, " ").trim().slice(0, 160);
    customs.push({ name, group, description });
  });
  return { customs, builtIns };
}

/** "Rice" -> "Food"; a custom category's chosen group; null if unknown. */
function categoryGroup(name, customs) {
  const builtIn = GROUP_OF.get(canonicalCategory(name));
  if (builtIn) return builtIn;
  const custom = (customs || []).find((c) => c.name === name);
  return custom ? custom.group : null;
}

/** The fuller wording handed to the detection model. */
function aiCategoryLabel(name, customs) {
  const custom = (customs || []).find((c) => c.name === name);
  if (custom) return custom.description ? `${custom.name} (${custom.description})` : custom.name;
  return AI_LABEL.get(name) || name;
}

/** A study's categories as the detection model should see them. */
function detectionCategories(study) {
  const customs = customCategoriesOf(study);
  return parseCategories(study && study.category).map((name) => ({ name, ai: aiCategoryLabel(name, customs) }));
}

/** Stored value -> array. Tolerates the old single-value strings and commas. */
function parseCategories(stored) {
  if (!stored) return [];
  return String(stored)
    .split(/[|,]/)
    .map(canonicalCategory)
    .filter((c, i, list) => c && list.indexOf(c) === i);
}

/** Form input (array or single string) -> the stored pipe-delimited value. */
function toStoredCategories(input, customs) {
  const list = (Array.isArray(input) ? input : input ? [input] : []).map(canonicalCategory);
  // Keep the canonical order regardless of the order boxes were ticked, and
  // drop anything not on the list -- the form posts values, and a stray one
  // shouldn't become a new de-facto category.
  const picked = CATEGORIES.filter((c) => list.includes(c))
    .concat((customs || []).map((c) => c.name));
  return picked.length ? picked.join("|") : null;
}

/** Human-readable, for anywhere a category is displayed. */
function formatCategories(stored) {
  const list = parseCategories(stored);
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

// The Categories checklist on the study settings screen, for a study that
// hasn't had any explicitly ticked yet: default to every category rather
// than none. An unconfigured list would otherwise leave brand-category
// detection with nothing to classify against, so "not set up yet" defaults
// to the widest net rather than the narrowest.
function selectedOrAllCategories(stored) {
  const list = parseCategories(stored);
  return list.length ? list : CATEGORIES.slice();
}

module.exports = {
  CATEGORY_GROUPS, CATEGORIES, CUSTOM_GROUPS, canonicalCategory, categoryGroup, aiCategoryLabel,
  parseCategories, toStoredCategories, formatCategories, selectedOrAllCategories,
  customCategoriesOf, normalizeCustomCategories, detectionCategories,
};

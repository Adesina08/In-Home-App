// Study reporting recipes (INICIO AI-Powered Research Reporting Framework,
// sections 3 and 4). A study's type decides which KPIs it gets and the story
// order they are reported in; nothing starts from a blank canvas.
//
// Each KPI names a deterministic calculation (lib/recipeKpis.js) and the
// questionnaire inputs that calculation needs. lib/kpiMapping.js asks the AI
// which of the study's own questions fill those inputs; a researcher approves
// the mapping before the KPI reaches a dashboard. The AI only ever chooses
// questions -- every number comes from the calculation named here.
//
// Input `accepts` lists the question types a calculation can read. `options`
// on an input means the KPI also needs to know which answer options count
// (e.g. which options of "Did you buy it?" mean bought): "required" options
// must be chosen for choice questions, "optional" ones narrow the measure.

const CHOICE = ["single", "multi"];
const NUMBER = ["numeric", "scale"];

const STUDY_TYPES = {
  ooh: {
    key: "ooh",
    label: "Out-of-Home Tracker",
    short: "Out-of-Home",
    unit: "respondents",
    description: "Who consumed what, where, when, with whom, how much, how often and why -- occasion-led.",
  },
  in_home: {
    key: "in_home",
    label: "In-Home Tracker",
    short: "In-Home",
    unit: "households",
    description: "The household cycle: purchase, stock, preparation, consumption, depletion and repurchase.",
  },
};

// Reusable input definitions. `describe` is what the AI reads when looking for
// the question; keep it about the question's meaning, not its wording.
const IN = {
  category: { role: "category", label: "Category question", accepts: CHOICE, options: "optional", optional: true,
    describe: "which product category was consumed (or whether the tracked category was consumed); options, if chosen, are the ones that count as consuming the tracked category" },
  brand: { role: "brand", label: "Brand question", accepts: CHOICE, describe: "which brand was consumed on this occasion" },
  daypart: { role: "daypart", label: "Time / daypart question", accepts: [...CHOICE, "time"], describe: "when it was consumed: time of day, daypart or meal moment (breakfast, lunch, dinner, late night)" },
  location: { role: "location", label: "Location question", accepts: CHOICE, describe: "where it was consumed (restaurant, workplace, school, roadside, transit, event, home...)" },
  needState: { role: "need_state", label: "Occasion / need question", accepts: CHOICE, describe: "why or for what occasion it was consumed (meal, refreshment, hunger, socialising, energy, indulgence...)" },
  companion: { role: "companion", label: "Companion question", accepts: CHOICE, describe: "who the respondent was with (alone, colleagues, friends, family, partner, group)" },
  pairing: { role: "pairing", label: "Food pairing question", accepts: CHOICE, describe: "what food or drink it was consumed together with" },
  quantity: { role: "quantity", label: "Quantity / volume question", accepts: NUMBER, describe: "how much was consumed on this occasion (units, servings, packs, litres)" },
  spend: { role: "spend", label: "Spend question", accepts: NUMBER, describe: "how much money was spent or paid on this occasion" },
  pack: { role: "pack", label: "Pack / serve format question", accepts: CHOICE, describe: "the pack or serving format (bottle, can, sachet, cup, plate, serving size)" },
  source: { role: "source", label: "Purchase source question", accepts: CHOICE, describe: "where it was bought (restaurant, kiosk, hawker, supermarket, convenience store, online)" },
  purchase: { role: "purchase", label: "Purchase question", accepts: [...CHOICE, ...NUMBER], options: "required",
    describe: "whether the household bought the product on this occasion, or how many it bought; for a choice question the options are the ones that mean it was bought" },
  purchaseQuantity: { role: "purchase_quantity", label: "Purchase size question", accepts: NUMBER, describe: "how many units, packs or how much volume was bought in one purchase" },
  channel: { role: "channel", label: "Purchase channel question", accepts: CHOICE, describe: "where the household bought it (open market, kiosk, supermarket, online, wholesale)" },
  trigger: { role: "trigger", label: "Purchase trigger question", accepts: CHOICE, describe: "why it was bought then (planned shopping, ran out, promotion, impulse, event)" },
  stock: { role: "stock", label: "Household stock question", accepts: [...CHOICE, ...NUMBER], options: "optional",
    describe: "how much of the product the household has in stock, or whether it has any; for a choice question the options are the ones that mean it is in stock" },
  stockedBrands: { role: "stocked", label: "Brands-in-stock question", accepts: CHOICE, describe: "which brands or products the household currently has in stock (pantry)" },
  preparation: { role: "preparation", label: "Preparation question", accepts: CHOICE, describe: "how the product was prepared, cooked or served at home" },
  mealOccasion: { role: "occasion", label: "Household occasion question", accepts: [...CHOICE, "time"], describe: "the household occasion or time it was consumed (breakfast, lunch, dinner, snacking)" },
  consumer: { role: "consumer", label: "Household consumer question", accepts: CHOICE, describe: "which household members consumed it (adults, children, specific age groups)" },
  householdSize: { role: "household_size", label: "Household size question", accepts: NUMBER, describe: "how many people live in the household, or how many members shared it" },
  householdVolume: { role: "quantity", label: "Quantity / volume question", accepts: NUMBER, describe: "how much the household consumed or used on this occasion (units, servings, packs, litres)" },
};

const k = (key, label, calc, definition, inputs = [], extra = {}) => ({ key, label, calc, definition, inputs, ...extra });

// Shared by both recipes so a KPI keeps its key (and its approved mapping)
// when a study's type is changed.
const SHARED = {
  frequency: k("consumption_frequency", "Consumption frequency", "occasions_per_week", "Average logged consumption occasions per participant per week."),
  trend: k("trend", "Week-on-week trend", "trend", "Change in logged occasions between the two most recent weeks with entries."),
  brandPenetration: k("brand_penetration", "Brand penetration", "brand_penetration", "% of participants who consumed each brand at least once in the period.", [IN.brand]),
  switching: k("switching", "Brand switching", "switching", "% of consecutive single-brand occasions, per participant, where the brand changed.", [IN.brand]),
  pairing: k("food_pairing", "Food pairing", "distribution", "Share of answered occasions mentioning each accompaniment.", [IN.pairing]),
};

const RECIPES = {
  ooh: {
    sections: [
      { key: "market_landscape", label: "Market Landscape", description: "How many consume, and how often." },
      { key: "occasions", label: "Consumption Occasions", description: "Why, with whom and with what." },
      { key: "dayparts", label: "Dayparts", description: "When consumption happens." },
      { key: "locations", label: "Locations", description: "Where it happens and where it is bought." },
      { key: "categories", label: "Categories", description: "What is consumed." },
      { key: "brands", label: "Brands", description: "Brand reach, share, repertoire and switching." },
      { key: "volume_spend", label: "Volume & Spend", description: "How much is consumed and paid." },
      { key: "profiles", label: "Consumer Profiles", description: "Who the consumers are." },
      { key: "opportunity_spaces", label: "Opportunity Spaces", narrative: true, description: "Written by the AI summary from the measures above." },
      { key: "conclusions", label: "Conclusions", narrative: true, description: "Written by the AI summary from the measures above." },
    ],
    kpis: [
      { section: "market_landscape", ...k("category_penetration", "Category penetration", "penetration", "% of participants who consumed the category within the period.", [IN.category]) },
      { section: "market_landscape", ...SHARED.frequency },
      { section: "market_landscape", ...SHARED.trend },
      { section: "occasions", ...k("need_state", "Occasion / need state", "distribution", "Share of answered occasions by need or occasion.", [IN.needState]) },
      { section: "occasions", ...k("companion", "Consumption companion", "distribution", "Share of answered occasions by who the participant was with.", [IN.companion]) },
      { section: "occasions", ...SHARED.pairing },
      { section: "dayparts", ...k("daypart", "Daypart", "distribution", "Share of answered occasions by daypart. A time-of-day question is grouped into dayparts.", [IN.daypart]) },
      { section: "locations", ...k("consumption_location", "Consumption location", "distribution", "Share of answered occasions by where consumption happened.", [IN.location]) },
      { section: "locations", ...k("purchase_source", "Purchase source", "distribution", "Share of answered occasions by where the product was bought.", [IN.source]) },
      { section: "categories", ...k("category_mix", "Category mix", "distribution", "Share of answered occasions by category consumed.", [{ ...IN.category, optional: false, options: undefined }]) },
      { section: "brands", ...SHARED.brandPenetration },
      { section: "brands", ...k("share_of_occasions", "Share of occasions", "share_of_occasions", "Occasions with each brand / all occasions that answered the brand question.", [IN.brand]) },
      { section: "brands", ...k("brand_repertoire", "Brand repertoire", "repertoire", "Average number of different brands each consuming participant used.", [IN.brand], { unit: "brands" }) },
      { section: "brands", ...SHARED.switching },
      { section: "volume_spend", ...k("volume_per_occasion", "Volume per occasion", "average", "Average quantity consumed per answered occasion.", [IN.quantity]) },
      { section: "volume_spend", ...k("total_volume", "Total period volume", "total", "Sum of quantity consumed across all answered occasions.", [IN.quantity]) },
      { section: "volume_spend", ...k("spend_per_occasion", "Spend per occasion", "average", "Average amount paid per answered occasion.", [IN.spend]) },
      { section: "volume_spend", ...k("price_per_unit", "Price per unit", "ratio", "Total spend / total quantity, over occasions that answered both.", [IN.spend, IN.quantity]) },
      { section: "volume_spend", ...k("pack_format", "Pack / serve format", "distribution", "Share of answered occasions by pack or serving format.", [IN.pack]) },
      { section: "profiles", ...k("consumers_by_gender", "Consumers by gender", "profile_split", "Consuming participants by gender, from their profile.", [], { segment: "gender" }) },
      { section: "profiles", ...k("consumers_by_age", "Consumers by age", "profile_split", "Consuming participants by age group, from their profile.", [], { segment: "age_band" }) },
      { section: "profiles", ...k("consumers_by_location", "Consumers by location", "profile_split", "Consuming participants by location, from their profile.", [], { segment: "location" }) },
    ],
  },
  in_home: {
    sections: [
      { key: "household_landscape", label: "Household Landscape", description: "How many households consume, and the trend." },
      { key: "purchase", label: "Purchase Behaviour", description: "How often, how much, where and why households buy." },
      { key: "stocking", label: "Stocking", description: "What households keep at home." },
      { key: "preparation", label: "Preparation", description: "How it is prepared and what it is eaten with." },
      { key: "consumption", label: "Consumption", description: "When, by whom and how much is consumed." },
      { key: "brand_performance", label: "Brand Performance", description: "Brand reach, main brand and switching." },
      { key: "household_segments", label: "Household Segments", description: "Heavy and light households, and who they are." },
      { key: "repurchase", label: "Repurchase", description: "The time between purchases." },
      { key: "opportunity_areas", label: "Opportunity Areas", narrative: true, description: "Written by the AI summary from the measures above." },
    ],
    kpis: [
      { section: "household_landscape", ...k("household_penetration", "Household penetration", "penetration", "% of households that consumed the category within the period.", [IN.category]) },
      { section: "household_landscape", ...SHARED.trend },
      { section: "purchase", ...k("purchase_frequency", "Purchase frequency", "purchase_rate", "Average purchase occasions per household in the period.", [IN.purchase], { unit: "purchases" }) },
      { section: "purchase", ...k("purchase_size", "Average purchase size", "average", "Average units, packs or volume bought per answered purchase.", [IN.purchaseQuantity]) },
      { section: "purchase", ...k("purchase_channel", "Purchase channel", "distribution", "Share of answered occasions by where households bought.", [IN.channel]) },
      { section: "purchase", ...k("purchase_trigger", "Purchase trigger", "distribution", "Share of answered occasions by why households bought.", [IN.trigger]) },
      { section: "purchase", ...k("household_spend", "Household spend", "per_respondent_total", "Total spend per spending household in the period.", [IN.spend]) },
      { section: "stocking", ...k("household_stock", "Household stock", "measure", "Average stock held, or % of answered occasions with stock in the home.", [IN.stock]) },
      { section: "stocking", ...k("pantry_repertoire", "Pantry repertoire", "repertoire", "Average number of different brands or products each household has had in stock.", [IN.stockedBrands], { unit: "products" }) },
      { section: "preparation", ...k("preparation_method", "Preparation method", "distribution", "Share of answered occasions by how it was prepared.", [IN.preparation]) },
      { section: "preparation", ...SHARED.pairing },
      { section: "consumption", ...SHARED.frequency, definition: "Average logged consumption occasions per household per week." },
      { section: "consumption", ...k("consumption_occasion", "Consumption occasion", "distribution", "Share of answered occasions by household occasion. A time-of-day question is grouped into dayparts.", [IN.mealOccasion]) },
      { section: "consumption", ...k("household_consumer", "Household consumer", "distribution", "Share of answered occasions mentioning each household member group.", [IN.consumer]) },
      { section: "consumption", ...k("household_volume", "Household volume", "total", "Sum of quantity consumed across all answered occasions.", [IN.householdVolume]) },
      { section: "consumption", ...k("per_capita", "Per-capita consumption", "per_capita", "Each household's period volume / its household size, averaged across households.", [IN.householdVolume, IN.householdSize]) },
      { section: "brand_performance", ...SHARED.brandPenetration, definition: "% of households that consumed each brand at least once in the period." },
      { section: "brand_performance", ...k("main_brand", "Main brand", "main_brand", "Each household's most frequently consumed brand, as a share of households.", [IN.brand]) },
      { section: "brand_performance", ...SHARED.switching, definition: "% of consecutive single-brand occasions, per household, where the brand changed." },
      { section: "household_segments", ...k("usage_tiers", "Heavy / medium / light households", "usage_tiers", "Households split into thirds by occasions logged; share of all occasions each third accounts for.") },
      { section: "household_segments", ...k("households_by_location", "Households by location", "profile_split", "Consuming households by location, from the participant profile.", [], { segment: "location" }) },
      { section: "household_segments", ...k("households_by_age", "Households by age of participant", "profile_split", "Consuming households by the participant's age group.", [], { segment: "age_band" }) },
      { section: "repurchase", ...k("repurchase_cycle", "Repurchase cycle", "repurchase_cycle", "Average days between a household's consecutive purchase days.", [IN.purchase], { unit: "days" }) },
    ],
  },
};

function recipeFor(studyType) {
  return RECIPES[studyType] || null;
}

function studyTypeOf(study) {
  return study && STUDY_TYPES[study.study_type] ? study.study_type : null;
}

/** Every KPI in the study's recipe, or [] for a study with no type yet. */
function recipeKpis(study) {
  const recipe = recipeFor(studyTypeOf(study));
  return recipe ? recipe.kpis : [];
}

/** Sections a hand-built KPI can be filed under for this study's type. */
function sectionOptions(study) {
  const recipe = recipeFor(studyTypeOf(study));
  return recipe ? recipe.sections.filter((s) => !s.narrative) : [];
}

module.exports = { STUDY_TYPES, RECIPES, recipeFor, studyTypeOf, recipeKpis, sectionOptions, CHOICE, NUMBER };

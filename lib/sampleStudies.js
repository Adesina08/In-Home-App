// Two SAMPLE studies -- one In-Home Tracker, one Out-of-Home Tracker -- filled
// with mock households, diary entries and photos, so a team can explore every
// screen (dashboards, recipe KPIs, crosstabs, QC, media) before running a
// study of its own.
//
// They are ordinary studies: admins can edit them like any other. Each is
// marked `sample_key` (and `is_sample: 1`), which is how startup knows it
// already exists, how the UI badges it, and how the reminder and end-of-study
// jobs know to leave its mock respondents alone. "Reset sample study" clears
// it and rebuilds it from the template below, in place, under the same id.
//
// Nothing here ever touches a real study: creation only adds, and reset only
// runs on a study carrying a sample_key. The mock data is generated from a
// fixed seed, so every build tells the same story, dated relative to the day
// it was built.

const { v4: uuidv4 } = require("uuid");
const store = require("./store");
const { RECIPES } = require("./studyRecipes");
const { clearStudyContents, SAMPLE_MEDIA_PREFIX } = require("./studyCleanup");

const DAYS = 14;
const HOUR = 36e5;

// ---------- Mock data helpers ----------

/** mulberry32: a small seeded generator, so the mock data is repeatable. */
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];
/** One key of { option: weight }, chosen in proportion to its weight. */
function weighted(r, weights) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  let x = r() * entries.reduce((sum, [, w]) => sum + w, 0);
  for (const [key, w] of entries) if ((x -= w) < 0) return key;
  return entries[entries.length - 1][0];
}
const between = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const roundTo = (n, step) => Math.max(step, Math.round(n / step) * step);
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

// ---------- In-Home: Home Cooking & Seasoning Diary ----------

const CUBE_PRICE = { Maggi: 60, Knorr: 60, Onga: 45, Royco: 40, "Mr Chef": 35 };
const DISHES = {
  Breakfast: { "Noodles with egg": 4, "Pap and akara": 3, "Bread and egg sauce": 3, "Yam and egg sauce": 2 },
  Lunch: { "Jollof rice": 4, "Rice and stew": 4, "Beans and plantain": 2, "Noodles with egg": 2 },
  Dinner: { "Soup and swallow": 5, "Rice and stew": 3, "Jollof rice": 2, "Beans and plantain": 2, "Yam and egg sauce": 1 },
  Snack: { "Noodles with egg": 3, "Bread and egg sauce": 1 },
};
const DISH_PHOTO = {
  "Jollof rice": "jollof-plate", "Rice and stew": "pot-stew", "Soup and swallow": "pot-stew",
  "Noodles with egg": "noodles-bowl", "Beans and plantain": "pot-stew", "Yam and egg sauce": "pot-stew",
  "Pap and akara": "seasoning-cubes", "Bread and egg sauce": "seasoning-cubes",
};
const DISH_PAIRING = {
  "Jollof rice": ["Chicken / meat", "Fried plantain"], "Rice and stew": ["Chicken / meat", "Fish", "Fried plantain"],
  "Soup and swallow": ["Fish", "Chicken / meat"], "Beans and plantain": ["Fried plantain", "Bread"],
  "Noodles with egg": ["Egg", "Bread"], "Yam and egg sauce": ["Egg"], "Pap and akara": ["Bread"], "Bread and egg sauce": ["Egg", "Bread"],
};
const COOKING_REASONS = [
  "It is the one my family likes best.", "It gives the stew a richer taste.", "It was what we had in the kitchen.",
  "My mother always used it, so I do too.", "It was on promotion at the market.", "It dissolves quickly and tastes balanced.",
  "The children prefer the taste.", "It is cheaper and still tastes good.", "I ran out of my usual brand and used this one.",
];

const IN_HOME = {
  key: "in_home",
  seed: 4101,
  entryRate: 0.85,
  study: {
    name: "Home Cooking & Seasoning Diary (SAMPLE)",
    study_type: "in_home",
    market: "Nigeria",
    market_country_code: "NG",
    market_regions: [],
    category: "Seasoning & Condiments|Instant Noodles|Rice",
    diary_mode: "daily",
    recruitment_mode: "hybrid",
    status: "live",
    mandatory_photo: 1,
    minimum_base_size: 5,
  },
  consent: "SAMPLE WORDING. Replace with your approved ethics and legal consent text. I agree to keep a daily diary of the meals my household cooks at home for two weeks. My answers and photos will be used for research only and handled in line with the study's privacy notice. I can stop taking part at any time.",
  questions: [
    { code: "meal_occasion", type: "single", text: "Which meal did your household cook?", options: ["Breakfast", "Lunch", "Dinner", "Snack"] },
    { code: "dish", type: "single", text: "What did you cook?", options: ["Jollof rice", "Rice and stew", "Soup and swallow", "Noodles with egg", "Beans and plantain", "Yam and egg sauce", "Pap and akara", "Bread and egg sauce"] },
    { code: "products_used", type: "multi", text: "Which of these did you use in this meal?", options: ["Seasoning cubes", "Tomato paste", "Vegetable oil", "Instant noodles", "None of these"] },
    { code: "brand", type: "single", text: "Which brand of seasoning cube did you use?", options: ["Maggi", "Knorr", "Onga", "Royco", "Mr Chef", "Other"], required: 0 },
    { code: "preparation", type: "single", text: "How did you use the seasoning?", options: ["In the stew or soup base", "Cooked into the rice", "Added to noodles", "Marinade for meat or fish", "Sprinkled at the end"], required: 0 },
    { code: "cubes_used", type: "numeric", text: "How many seasoning cubes did you use?", min: 0, max: 12, required: 0 },
    { code: "pairing", type: "multi", text: "What was it eaten with?", options: ["Chicken / meat", "Fish", "Egg", "Fried plantain", "Bread", "Salad"] },
    { code: "consumers", type: "multi", text: "Who in the household ate this meal?", options: ["Adults", "Teenagers", "Children under 12"] },
    { code: "household_size", type: "numeric", text: "How many people live in your household?", min: 1, max: 15 },
    { code: "bought_today", type: "single", text: "Did you buy seasoning cubes today?", options: ["Yes", "No"] },
    { code: "cubes_bought", type: "numeric", text: "How many cubes did you buy?", min: 1, max: 200, required: 0 },
    { code: "purchase_channel", type: "single", text: "Where did you buy them?", options: ["Open market", "Neighbourhood kiosk", "Supermarket", "Wholesaler", "Online"], required: 0 },
    { code: "purchase_trigger", type: "single", text: "Why did you buy them today?", options: ["Ran out", "Planned shopping trip", "Promotion or price offer", "Saw it and remembered", "Cooking for guests"], required: 0 },
    { code: "spend", type: "numeric", text: "How much did you pay in total (₦)?", min: 0, max: 50000, required: 0 },
    { code: "stock_left", type: "single", text: "How many seasoning cubes are left at home now?", options: ["None", "A few cubes", "About half a pack", "A full pack or more"] },
    { code: "pantry_brands", type: "multi", text: "Which seasoning brands do you have at home right now?", options: ["Maggi", "Knorr", "Onga", "Royco", "Mr Chef"], required: 0 },
    { code: "reason", type: "text", text: "Why did you choose this seasoning today?", required: 0 },
    { code: "evidence", type: "photo", text: "Take a photo of the meal or the ingredients." },
  ],
  kpiInputs: {
    category: ["products_used", ["Seasoning cubes"]],
    brand: "brand",
    purchase: ["bought_today", ["Yes"]],
    purchase_quantity: "cubes_bought",
    channel: "purchase_channel",
    trigger: "purchase_trigger",
    spend: "spend",
    stock: ["stock_left", ["A few cubes", "About half a pack", "A full pack or more"]],
    stocked: "pantry_brands",
    preparation: "preparation",
    pairing: "pairing",
    occasion: "meal_occasion",
    consumer: "consumers",
    quantity: "cubes_used",
    household_size: "household_size",
  },
  people: [
    ["Adaeze Okafor", "female", 34, "Lagos"], ["Bolaji Adewale", "male", 41, "Lagos"], ["Chiamaka Nnadi", "female", 29, "Enugu"],
    ["Fatima Bello", "female", 37, "Kano"], ["Ifeoma Uche", "female", 46, "Port Harcourt"], ["Kehinde Ogun", "female", 31, "Ibadan"],
    ["Musa Abdullahi", "male", 52, "Abuja"], ["Nkechi Okonkwo", "female", 27, "Lagos"], ["Olumide Fashola", "male", 38, "Ibadan"],
    ["Rukayat Lawal", "female", 44, "Abuja"], ["Tobi Adeleke", "female", 23, "Lagos"], ["Uchenna Eze", "male", 33, "Enugu"],
    ["Yetunde Bankole", "female", 58, "Lagos"], ["Zainab Sani", "female", 30, "Kano"],
  ],
  pending: [["Amaka Ibe", "invited", "pending"], ["Dayo Ojo", "registered", "pending"]],
  // Each household: a main brand it mostly sticks to, a size, and children or not.
  household(r) {
    const main = weighted(r, { Maggi: 5, Knorr: 4, Onga: 2, Royco: 1, "Mr Chef": 1 });
    const second = weighted(r, Object.fromEntries(Object.keys(CUBE_PRICE).filter((b) => b !== main).map((b) => [b, 1])));
    const size = between(r, 2, 8);
    return { main, second, loyalty: 0.6 + r() * 0.35, size, kids: size > 3 && r() < 0.8, teens: size > 4 && r() < 0.5, stock: between(r, 2, 20), channel: weighted(r, { "Open market": 5, "Neighbourhood kiosk": 4, Supermarket: 2, Wholesaler: 1 }) };
  },
  // Times of day each meal is cooked, as [earliest hour, latest hour].
  entry(r, hh) {
    const meal = weighted(r, { Breakfast: 2, Lunch: 3, Dinner: 5, Snack: 1 });
    const hour = { Breakfast: [6, 9], Lunch: [12, 15], Dinner: [18, 21], Snack: [10, 17] }[meal];
    const dish = weighted(r, DISHES[meal]);
    const products = [];
    const seasoned = r() < 0.9;
    if (seasoned) products.push("Seasoning cubes");
    if (/rice|stew|Soup/.test(dish) && r() < 0.6) products.push("Tomato paste");
    if (r() < 0.75) products.push("Vegetable oil");
    if (dish === "Noodles with egg") products.push("Instant noodles");
    const a = {
      meal_occasion: meal, dish, products_used: products.length ? products : ["None of these"],
      pairing: DISH_PAIRING[dish].filter(() => r() < 0.6).concat(r() < 0.08 ? ["Salad"] : []).filter((v, i, all) => all.indexOf(v) === i),
      consumers: ["Adults"].concat(hh.teens && r() < 0.8 ? ["Teenagers"] : [], hh.kids && r() < 0.85 ? ["Children under 12"] : []),
      household_size: hh.size,
    };
    if (!a.pairing.length) a.pairing = [DISH_PAIRING[dish][0]];
    let used = 0;
    if (seasoned) {
      a.brand = r() < hh.loyalty ? hh.main : r() < 0.7 ? hh.second : pick(r, Object.keys(CUBE_PRICE));
      a.preparation = dish === "Noodles with egg" ? "Added to noodles" : /rice/i.test(dish) && r() < 0.5 ? "Cooked into the rice" : weighted(r, { "In the stew or soup base": 6, "Marinade for meat or fish": 2, "Sprinkled at the end": 1 });
      used = Math.max(1, Math.round(hh.size / 3 + r() * 2));
      a.cubes_used = used;
      a.reason = pick(r, COOKING_REASONS);
    }
    hh.stock = Math.max(0, hh.stock - used);
    // Households restock when they run low -- some only once they have run out
    // -- and now and then on a promotion.
    const buy = (hh.stock <= 4 && r() < 0.45) || r() < 0.05;
    a.bought_today = buy ? "Yes" : "No";
    if (buy) {
      const qty = pick(r, [10, 10, 20, 20, 50]);
      const brand = a.brand || hh.main;
      a.cubes_bought = qty;
      a.purchase_channel = r() < 0.8 ? hh.channel : weighted(r, { "Open market": 3, "Neighbourhood kiosk": 3, Supermarket: 2, Wholesaler: 1, Online: 1 });
      a.purchase_trigger = hh.stock <= 4 ? weighted(r, { "Ran out": 6, "Planned shopping trip": 3 }) : weighted(r, { "Promotion or price offer": 3, "Saw it and remembered": 2, "Cooking for guests": 1 });
      a.spend = roundTo(qty * CUBE_PRICE[brand] * (0.9 + r() * 0.2), 50);
      hh.stock += qty;
    }
    a.stock_left = hh.stock === 0 ? "None" : hh.stock <= 10 ? "A few cubes" : hh.stock <= 30 ? "About half a pack" : "A full pack or more";
    a.pantry_brands = hh.stock ? [hh.main].concat(r() < 0.4 ? [hh.second] : []) : [];
    if (!a.pantry_brands.length) delete a.pantry_brands;
    return { hours: hour, answers: a, photo: DISH_PHOTO[dish] };
  },
};

// ---------- Out-of-Home: On-the-Go Snacks & Drinks ----------

const OOH_BRANDS = {
  "Soft drink": { "Coca-Cola": 5, Pepsi: 3, Fanta: 3, Bigi: 2 },
  "Energy drink": { "Fearless": 4, "Power Horse": 2, "Red Bull": 1, "Predator": 3 },
  "Malt drink": { "Malta Guinness": 5, "Amstel Malta": 3, "Maltina": 4 },
  "Bottled water": { "Eva Water": 4, "Nestlé Pure Life": 3, "Aquafina": 3 },
  "Juice": { "Chivita": 4, "Five Alive": 3, "Hollandia": 2 },
  "Snack (chips, biscuits)": { "Pringles": 1, "Gala": 4, "Cabin Biscuits": 3, "Plantain chips": 3 },
  // Pastries are mostly unbranded, so they are logged without a brand.
  "Pastry (meat pie, puff-puff)": {},
};
const OOH_PRICE = { "Soft drink": 350, "Energy drink": 600, "Malt drink": 500, "Bottled water": 200, "Juice": 750, "Snack (chips, biscuits)": 300, "Pastry (meat pie, puff-puff)": 600 };
const OOH_PACK = { "Soft drink": { "PET bottle": 5, "Glass bottle": 3, Can: 2 }, "Energy drink": { Can: 6, "PET bottle": 2 }, "Malt drink": { Can: 5, "Glass bottle": 3 }, "Bottled water": { "PET bottle": 6, Sachet: 4 }, "Juice": { "Carton": 5, "PET bottle": 2 }, "Snack (chips, biscuits)": { "Pack or wrapper": 1 }, "Pastry (meat pie, puff-puff)": { "Pack or wrapper": 1 } };
const OOH_NEED = { "Soft drink": { "Refreshment / thirst": 4, "With a meal": 4, Socialising: 2 }, "Energy drink": { "Energy boost": 7, "Refreshment / thirst": 1 }, "Malt drink": { "With a meal": 3, "Treat myself": 3, "Energy boost": 2 }, "Bottled water": { "Refreshment / thirst": 8 }, "Juice": { "Treat myself": 3, "With a meal": 2, "Refreshment / thirst": 2 }, "Snack (chips, biscuits)": { "Hunger between meals": 6, "Treat myself": 2 }, "Pastry (meat pie, puff-puff)": { "Hunger between meals": 6, "With a meal": 2 } };
const OOH_PHOTO = { "Soft drink": "soft-drink", "Energy drink": "energy-can", "Malt drink": "snack-pack", "Bottled water": "meat-pie", "Juice": "soft-drink", "Snack (chips, biscuits)": "snack-pack", "Pastry (meat pie, puff-puff)": "meat-pie" };
const OOH_REASONS = [
  "I was thirsty after the walk from the bus stop.", "I needed something to keep me awake for the afternoon.", "It was the coldest one in the fridge.",
  "My colleagues were all buying one.", "It is my usual with lunch.", "It was cheap and close by.", "I wanted a small treat after work.",
  "The vendor near the office always has it.", "I had not eaten since morning.",
];

const OUT_OF_HOME = {
  key: "ooh",
  seed: 7202,
  entryRate: 1.1,
  study: {
    name: "On-the-Go Snacks & Drinks (SAMPLE)",
    study_type: "ooh",
    market: "Nigeria",
    market_country_code: "NG",
    market_regions: [],
    category: "CSD|Energy Drinks|Malt drinks|Water|Fruit Juices|Snacks",
    diary_mode: "realtime",
    recruitment_mode: "remote",
    status: "live",
    mandatory_photo: 1,
    minimum_base_size: 5,
  },
  consent: "SAMPLE WORDING. Replace with your approved ethics and legal consent text. I agree to log the snacks and drinks I buy and consume outside my home for two weeks. My answers and photos will be used for research only and handled in line with the study's privacy notice. I can stop taking part at any time.",
  questions: [
    { code: "category", type: "single", text: "What did you have?", options: Object.keys(OOH_BRANDS) },
    { code: "brand", type: "single", text: "Which brand was it?", options: [...new Set(Object.values(OOH_BRANDS).flatMap(Object.keys))].concat("Other") },
    { code: "daypart", type: "single", text: "When did you have it?", options: ["Morning (before 11am)", "Midday (11am to 2pm)", "Afternoon (2pm to 5pm)", "Evening (5pm to 9pm)", "Late night (after 9pm)"] },
    { code: "location", type: "single", text: "Where were you?", options: ["Workplace", "School or campus", "In transit or roadside", "Restaurant or eatery", "Market", "Event or party", "Gym or sports"] },
    { code: "need", type: "single", text: "Why did you have it?", options: ["Refreshment / thirst", "Hunger between meals", "Energy boost", "With a meal", "Socialising", "Treat myself"] },
    { code: "companion", type: "single", text: "Who were you with?", options: ["Alone", "Colleagues", "Friends", "Family", "Partner"] },
    { code: "pairing", type: "single", text: "Did you have it with anything?", options: ["Nothing", "Meat pie or pastry", "Rice dish", "Suya or grilled meat", "Biscuits or snacks", "A drink"] },
    { code: "quantity", type: "numeric", text: "How many did you have?", min: 1, max: 10 },
    { code: "spend", type: "numeric", text: "How much did you pay (₦)?", min: 0, max: 20000 },
    { code: "pack", type: "single", text: "What pack was it?", options: ["PET bottle", "Glass bottle", "Can", "Sachet", "Carton", "Pack or wrapper"] },
    { code: "source", type: "single", text: "Where did you buy it?", options: ["Kiosk or table-top", "Supermarket", "Hawker or roadside", "Restaurant or eatery", "Office canteen", "Fuel station shop"] },
    { code: "why_brand", type: "text", text: "Tell us a little about this moment.", required: 0 },
    { code: "evidence", type: "photo", text: "Take a photo of what you had." },
  ],
  kpiInputs: {
    category: "category",
    brand: "brand",
    daypart: "daypart",
    location: "location",
    need_state: "need",
    companion: "companion",
    pairing: "pairing",
    quantity: "quantity",
    spend: "spend",
    pack: "pack",
    source: "source",
  },
  people: [
    ["Ayo Bamidele", "male", 24, "Lagos", "student"], ["Blessing Udo", "female", 31, "Lagos", "office"], ["Chinedu Obi", "male", 27, "Abuja", "office"],
    ["Damilola Akin", "female", 22, "Ibadan", "student"], ["Emeka Nwachukwu", "male", 35, "Port Harcourt", "trader"], ["Funke Ajayi", "female", 42, "Lagos", "trader"],
    ["Gbenga Oyelaran", "male", 29, "Lagos", "office"], ["Hauwa Garba", "female", 26, "Kano", "office"], ["Ikechukwu Agu", "male", 19, "Enugu", "student"],
    ["Jumoke Oladipo", "female", 38, "Abuja", "office"], ["Kunle Afolabi", "male", 45, "Ibadan", "trader"], ["Lami Danjuma", "female", 33, "Abuja", "office"],
    ["Mayowa Ige", "male", 21, "Lagos", "student"], ["Ngozi Ani", "female", 50, "Enugu", "trader"],
  ],
  pending: [["Peter Ekpo", "invited", "pending"], ["Sade Coker", "registered", "pending"]],
  // Younger men lean to energy drinks, office workers to soft drinks and water.
  household(r, person) {
    const young = person.age < 30, male = person.gender === "male";
    const prefs = {
      "Soft drink": 5, "Energy drink": young && male ? 5 : young ? 2 : 1, "Malt drink": 3, "Bottled water": person.work === "office" ? 4 : 3,
      "Juice": male ? 1 : 3, "Snack (chips, biscuits)": person.work === "student" ? 4 : 2, "Pastry (meat pie, puff-puff)": person.work === "trader" ? 2 : 3,
    };
    // Most people keep to two or three go-to categories.
    for (let i = 0; i < 2; i++) prefs[weighted(r, prefs)] *= 4;
    const favourite = Object.fromEntries(Object.entries(OOH_BRANDS).filter(([, brands]) => Object.keys(brands).length).map(([cat, brands]) => [cat, weighted(r, brands)]));
    const places = { student: { "School or campus": 6, "In transit or roadside": 3, "Event or party": 1, "Gym or sports": 1 }, office: { Workplace: 6, "In transit or roadside": 3, "Restaurant or eatery": 2, "Event or party": 1 }, trader: { Market: 6, "In transit or roadside": 3, "Restaurant or eatery": 1 } }[person.work];
    return { prefs, favourite, loyalty: 0.55 + r() * 0.35, places };
  },
  entry(r, p) {
    const category = weighted(r, p.prefs);
    const brand = !p.favourite[category] ? undefined : r() < p.loyalty ? p.favourite[category] : weighted(r, OOH_BRANDS[category]);
    const daypart = weighted(r, { "Morning (before 11am)": category === "Energy drink" ? 3 : 2, "Midday (11am to 2pm)": 4, "Afternoon (2pm to 5pm)": 4, "Evening (5pm to 9pm)": 3, "Late night (after 9pm)": 1 });
    const hours = { "Morning (before 11am)": [7, 10], "Midday (11am to 2pm)": [11, 13], "Afternoon (2pm to 5pm)": [14, 16], "Evening (5pm to 9pm)": [17, 20], "Late night (after 9pm)": [21, 22] }[daypart];
    const location = weighted(r, p.places);
    const need = weighted(r, OOH_NEED[category]);
    const companion = location === "Workplace" ? weighted(r, { Colleagues: 5, Alone: 4 }) : location === "School or campus" ? weighted(r, { Friends: 6, Alone: 3 }) : location === "Event or party" ? weighted(r, { Friends: 4, Family: 3, Partner: 2 }) : weighted(r, { Alone: 6, Friends: 2, Family: 1, Partner: 1 });
    const food = /Snack|Pastry/.test(category);
    const pairing = food ? weighted(r, { "A drink": 6, Nothing: 4 }) : need === "With a meal" ? weighted(r, { "Rice dish": 4, "Meat pie or pastry": 3, "Suya or grilled meat": 2 }) : weighted(r, { Nothing: 6, "Biscuits or snacks": 2, "Meat pie or pastry": 2 });
    const quantity = r() < 0.85 ? 1 : 2;
    const source = location === "Workplace" ? weighted(r, { "Office canteen": 4, "Kiosk or table-top": 4, "Hawker or roadside": 2 })
      : location === "Restaurant or eatery" ? "Restaurant or eatery"
      : location === "Market" ? weighted(r, { "Kiosk or table-top": 5, "Hawker or roadside": 4 })
      : weighted(r, { "Kiosk or table-top": 5, "Hawker or roadside": 4, Supermarket: 2, "Fuel station shop": 1 });
    const answers = {
      category, brand, daypart, location, need, companion, pairing, quantity,
      spend: roundTo(quantity * OOH_PRICE[category] * (source === "Supermarket" ? 0.9 : source === "Restaurant or eatery" ? 1.4 : 1) * (0.9 + r() * 0.25), 50),
      pack: weighted(r, OOH_PACK[category]), source,
    };
    if (r() < 0.6) answers.why_brand = pick(r, OOH_REASONS);
    return { hours, answers, photo: OOH_PHOTO[category] };
  },
};

const TEMPLATES = { in_home: IN_HOME, ooh: OUT_OF_HOME };

// ---------- Building ----------

/** The study's recipe KPIs, pre-mapped onto the sample questionnaire and approved. */
async function mapKpis(studyId, template, questionIds, questionOptions) {
  const now = store.nowSql();
  for (const kpi of RECIPES[template.study.study_type].kpis) {
    if (!kpi.inputs.length) continue;
    const inputs = {};
    for (const spec of kpi.inputs) {
      const mapped = template.kpiInputs[spec.role];
      if (!mapped) continue;
      const [code, options = []] = Array.isArray(mapped) ? mapped : [mapped];
      // A KPI that counts every option of a choice question (category mix) takes no option filter.
      const counted = spec.options ? options : [];
      if (spec.options === "required" && !counted.length) continue;
      inputs[spec.role] = { question_id: questionIds[code], options: counted.filter((o) => questionOptions[code].includes(o)) };
    }
    if (!kpi.inputs.filter((i) => !i.optional).every((i) => inputs[i.role])) continue;
    await store.insert("kpi_mappings", {
      study_id: studyId, kpi_key: kpi.key, inputs_json: JSON.stringify(inputs), status: "approved", source: "manual",
      confidence: null, reason: "Pre-mapped for the sample study.", proposed_at: now, reviewed_by: "system", reviewed_at: now,
    });
  }
  await store.update("studies", { id: studyId }, { kpi_mapping_status: "done", kpi_mapped_at: now, kpi_mapping_error: null });
}

/** Fill an (empty) study with the template's questionnaire, people and two weeks of entries. */
async function populate(studyId, template, { now = Date.now() } = {}) {
  const r = seeded(template.seed);
  const start = now - DAYS * 24 * HOUR;

  // Questionnaire, consent and the built-in KPI tiles.
  const questionIds = {}, questionOptions = {};
  for (const [i, q] of template.questions.entries()) {
    const { id } = await store.insert("questions", {
      study_id: studyId, order_index: i + 1, code: q.code, type: q.type, text: q.text, required: q.required ?? 1,
      options_json: q.options ? JSON.stringify(q.options) : null, min_value: q.min ?? null, max_value: q.max ?? null,
    });
    questionIds[q.code] = id;
    questionOptions[q.code] = q.options || [];
  }
  await store.insert("consent_versions", { study_id: studyId, version: 1, status: "approved", approved_by: "Sample study", approved_at: store.nowSql(), body: template.consent });
  for (const [key, label] of [["completion_rate", "Diary Completion Rate"], ["compliance_rate", "Compliance Rate"], ["brand_incidence", "Brand Incidence"], ["avg_occasions_per_week", "Avg Occasions / Week"], ["qc_flag_rate", "QC Flag Rate"], ["active_respondents", "Active Respondents"]]) {
    await store.insert("kpi_config", { study_id: studyId, kpi_key: key, label, enabled: 1 });
  }
  await require("./questionnaireVersions").ensureSnapshot(studyId, 1, { actor: "system", source: "sample_study" });
  await mapKpis(studyId, template, questionIds, questionOptions);

  // People. Contacts are left empty on purpose: a mock respondent must never
  // match a real phone number in the join/OTP flows or be messaged.
  const code = (n) => `R${String(studyId).padStart(2, "0")}-${String(n).padStart(4, "0")}`;
  const startDay = sqlTime(start).slice(0, 10);
  const active = [];
  for (const [i, [name, gender, age, location, work]] of template.people.entries()) {
    const { id } = await store.insert("respondents", {
      study_id: studyId, respondent_code: code(i + 1), name, contact: null, recruitment_mode: i % 3 ? "remote" : "f2f",
      preferred_channel: i % 4 ? "app" : "whatsapp", consent_status: "given", activation_status: "active", media_consent: true,
      unique_token: uuidv4(), is_practice: 0, participation_start: startDay, activated_at: sqlTime(start),
    });
    await store.insert("respondent_profile_snapshots", {
      profile_id: null, respondent_id: id, study_id: studyId, captured_at: sqlTime(start),
      snapshot_json: JSON.stringify({ name, gender, age, location, education_level: null, occupation: work || null }),
    });
    const person = { id, name, gender, age, location, work, channel: i % 4 ? "app" : "whatsapp" };
    active.push({ ...person, state: template.household(r, person) });
  }
  for (const [i, [name, status, consent]] of template.pending.entries()) {
    await store.insert("respondents", {
      study_id: studyId, respondent_code: code(template.people.length + i + 1), name, contact: null, recruitment_mode: "remote",
      preferred_channel: "app", consent_status: consent, activation_status: status, unique_token: uuidv4(), is_practice: 0,
    });
  }

  // Two weeks of entries, oldest first so each household's stock runs in order.
  const { runQcForRecord } = require("./qc");
  let records = 0;
  for (let day = DAYS; day >= 1; day--) {
    for (const person of active) {
      const count = (r() < template.entryRate ? 1 : 0) + (r() < template.entryRate - 0.6 ? 1 : 0);
      for (let n = 0; n < count; n++) {
        const { hours, answers, photo } = template.entry(r, person.state, person);
        const dayStart = new Date(now - day * 24 * HOUR).setUTCHours(0, 0, 0, 0);
        const occurred = dayStart + (between(r, hours[0], hours[1]) - 1) * HOUR + between(r, 0, 59) * 60000; // WAT is UTC+1
        // A couple of planted problems per study, so QC has something to show:
        // an entry made long after the event, and one without its photo.
        const late = day >= 4 && records % 37 === 11;
        const noPhoto = records % 53 === 29;
        const entered = Math.min(now - 60000, occurred + (late ? between(r, 30, 44) : 0.2 + r() * 2.5) * HOUR);
        const { id: recordId } = await store.insert("diary_records", {
          respondent_id: person.id, study_id: studyId, period_label: sqlTime(occurred).slice(0, 10),
          occurrence_time: sqlTime(occurred), entry_time: sqlTime(entered), submit_time: sqlTime(entered),
          channel: person.channel, status: "submitted", is_practice: 0, entry_mode: "standard", study_version: 1,
        });
        for (const [qcode, value] of Object.entries(answers)) {
          if (value === undefined || value === null) continue;
          await store.insert("responses", { record_id: recordId, question_id: questionIds[qcode], value: Array.isArray(value) ? value.join("|") : String(value), study_version: 1, source: "form" });
        }
        if (!noPhoto) {
          await store.insert("media", { record_id: recordId, question_id: questionIds.evidence, media_type: "photo", mimetype: "image/svg+xml", file_path: `${SAMPLE_MEDIA_PREFIX}${photo}.svg` });
        }
        // Checked as it lands, like a real submission: QC's burst rule counts
        // the entries made after the one it checks, so running it at the end would miscount.
        if (late || noPhoto) await runQcForRecord(recordId);
        records++;
      }
    }
  }

  // One entry started today and not yet submitted.
  await store.insert("diary_records", {
    respondent_id: active[0].id, study_id: studyId, period_label: sqlTime(now).slice(0, 10),
    occurrence_time: sqlTime(now - HOUR), entry_time: sqlTime(now - HOUR), channel: "app", status: "draft", is_practice: 0,
  });
  return { respondents: active.length + template.pending.length, records };
}

// ---------- Public ----------

/** Create any sample study that does not exist yet. Never touches an existing study. */
async function ensureSampleStudies({ now } = {}) {
  const created = [];
  for (const template of Object.values(TEMPLATES)) {
    if (await store.findOne("studies", { sample_key: template.key })) continue;
    const { id } = await store.insert("studies", { ...template.study, sample_key: template.key, is_sample: 1 });
    try {
      await populate(id, template, { now });
    } catch (e) {
      // Remove the half-built study so the next start tries again from scratch.
      await clearStudyContents(id).catch(() => {});
      await store.remove("studies", { id });
      throw e;
    }
    created.push(id);
  }
  if (created.length) console.log(`Created sample stud${created.length === 1 ? "y" : "ies"}: ${created.join(", ")}`);
  return created;
}

/** Clear a sample study and rebuild it from its template, keeping its id and who can see it. */
async function resetSampleStudy(studyId, { now } = {}) {
  const study = await store.findOne("studies", { id: studyId });
  const template = study && TEMPLATES[study.sample_key];
  if (!template) throw Object.assign(new Error("Only a sample study can be reset."), { status: 400 });
  await clearStudyContents(studyId, { keepAccess: true });
  await store.update("studies", { id: studyId }, {
    ...template.study, sample_key: template.key, is_sample: 1, version: 1, questionnaire_dirty: 0,
    end_date: null, require_record_approval: 0,
  });
  return populate(studyId, template, { now });
}

function isSampleStudy(study) {
  return !!(study && study.sample_key && TEMPLATES[study.sample_key]);
}

module.exports = { ensureSampleStudies, resetSampleStudy, isSampleStudy, TEMPLATES };

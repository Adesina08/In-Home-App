// Fictional demo content for the Soren (admin.inicio-soren.xyz) marketing videos.
// Brands, people and phone numbers are invented.

const PROJECT = {
  title: 'Morning Beverage Habits Study',
  description: 'A two-week study of how adults in Lagos and Abuja choose, buy and enjoy their first drink of the day, '
    + 'from tea and coffee to malt drinks and juice. A quick daily questionnaire is paired with an AI-moderated '
    + 'conversation to understand morning routines, brand choice and price sensitivity.',
  purpose: 'Market Research',
  preSurvey: ['Location', 'Age', 'Gender', 'Occupation'],
};

// Level 1: answered in Individual Online — Bot Mode. Uploaded as a DOCX in the import template's columns.
const QUESTIONNAIRE_LEVEL = 'Daily Morning Drink Log';
const QUESTIONS = [
  ['What did you drink first this morning?', 'single_choice', 'Tea | Coffee | Malt drink | Fruit juice | Water | Nothing', 'Your morning drink', ''],
  ['Which brand was it?', 'single_choice', 'Sunrise Malt | Kola Breeze | Nectar Gold | Zest Up | Another brand', 'Your morning drink', 'Show if Q1 is not Water or Nothing'],
  ['Where did you have it?', 'single_choice', 'At home | At work | On the way | At school', 'Your morning drink', ''],
  ['Who were you with?', 'multiple_choice', 'Alone | Family | Friends | Colleagues', 'Your morning drink', ''],
  ['How much did you enjoy it?', 'rating', '1 = Not at all | 5 = Loved it', 'Your opinion', ''],
  ['How much did it cost you, in naira?', 'number', '', 'Your opinion', ''],
  ['Would you buy it again?', 'yes_no', 'Yes | No', 'Your opinion', ''],
  ['In your own words, why did you choose this drink today?', 'text', '', 'Your opinion', ''],
];

// Level 2: answered in Individual Online — AI Bot Mode.
const GUIDE_LEVEL = 'Morning Routine Conversation';
const GUIDE = {
  objective: 'Understand the role the first drink plays in people\'s mornings, what drives their brand choice, and how recent price changes are shaping their habits.',
  prompts: [
    { section: 'Warm-up', text: 'Walk me through your morning today, from waking up to leaving home.', mustCover: true, minutes: '3', probe: 'When in that routine did you have your first drink?' },
    { section: 'Brand choice', text: 'How did you decide what to drink this morning, and why that brand?', mustCover: true, minutes: '4', probe: 'What would make you switch to another brand?' },
    { section: 'Price', text: 'Have recent price changes affected what you drink in the morning?', mustCover: true, minutes: '4', probe: 'What have you cut down on or switched to?' },
    { section: 'Wrap-up', text: 'If you could design the perfect morning drink, what would it be like?', mustCover: false, minutes: '2', probe: '' },
  ],
};

const SESSIONS = {
  bot: { name: 'Morning Drink Log', type: 'Individual Online — Bot Mode', level: QUESTIONNAIRE_LEVEL },
  ai: { name: 'Morning Routine Chat', type: 'Individual Online — AI Bot Mode', level: GUIDE_LEVEL },
};

module.exports = { PROJECT, QUESTIONNAIRE_LEVEL, QUESTIONS, GUIDE_LEVEL, GUIDE, SESSIONS };

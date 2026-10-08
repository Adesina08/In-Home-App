// Writes .work/noodles-questionnaire.xlsx: a realistic diary questionnaire in the
// app's own import template format, using its advanced logic columns
// (terminate, exclusive, scores, skip logic, variables, custom logic, piping).
const path = require('path');
const { APP, WORK } = require('./config');
const X = require(path.join(APP, 'node_modules', 'xlsx'));

const HEAD = ['Code', 'Section', 'Question', 'Type', 'Options', 'Required', 'Cadence', 'Minimum', 'Maximum', 'Condition', 'Other specify options',
  'Terminate entry options', 'Terminate study options', 'Exclusive options', 'Option scores', 'Skip logic', 'Default jump', 'Set variables', 'Custom logic'];
const ROWS = [
  ['Q1', 'Screening', 'Did you eat instant noodles today?', 'single', 'Yes|No', 'Yes', 'daily', '', '', '', '', 'No', '', '', '', '', '', '', ''],
  ['Q2', 'The meal', 'Which brand did you eat?', 'single', 'Golden Strands|Mama Pot|Quick Bowl|Other', 'Yes', 'daily', '', '', '', 'Other', '', '', '', '', '', '', 'Golden Strands=brand|Mama Pot=brand|Quick Bowl=brand|Other=brand', ''],
  ['Q3', 'The meal', 'What did you add to your ${brand} noodles?', 'multi', 'Egg|Vegetables|Sausage|Fish|Nothing', 'Yes', 'daily', '', '', '', '', '', '', 'Nothing', 'Egg=2|Vegetables=2|Sausage=1|Fish=1', '', '', '', ''],
  ['Q4', 'The meal', 'How many packs did you cook?', 'numeric', '', 'Yes', 'daily', '1', '10', '', '', '', '', '', '', '', '', '', ''],
  ['Q5', 'The meal', 'Who did you share it with?', 'single', 'Nobody|Children|Partner|Friends', 'Yes', 'daily', '', '', '', '', '', '', '', '', 'Nobody=Q7', '', 'Nobody=occasion:solo|Children=occasion:family|Partner=occasion:family|Friends=occasion:social', ''],
  ['Q6', 'The meal', 'How old are the children you cooked for?', 'single', 'Under 5|5 to 12|13 or older', 'No', 'daily', '', '', 'Show if Q5 equals Children', '', '', '', '', '', '', '', '', ''],
  ['Q7', 'Rating', 'How would you rate your ${brand} noodles today?', 'single', 'Excellent|Good|Okay|Poor', 'Yes', 'daily', '', '', '', '', '', '', '', 'Excellent=3|Good=2|Okay=1|Poor=0', '', '', '', ''],
  ['Q8', 'Rating', 'What made them poor today?', 'text', '', 'Yes', 'daily', '', '', '', '', '', '', '', '', '', '', '', "Show if answer('Q7') == 'Poor' and number('Q4') >= 1"],
  ['Q9', 'Rating', 'Nutrition score ${score}: would you call this a balanced meal?', 'single', 'Yes|No|Not sure', 'No', 'daily', '', '', '', '', '', '', '', '', '', '', '', 'Show if score >= 4'],
  ['Q10', 'Evidence', 'Take a photo of your bowl', 'photo', '', 'Yes', 'daily', '', '', '', '', '', '', '', '', '', '', '', ''],
];
const wb = X.utils.book_new();
X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([HEAD, ...ROWS]), 'Questionnaire');
const out = path.join(WORK, 'noodles-questionnaire.xlsx');
X.writeFile(wb, out);
console.log(`${ROWS.length} questions -> ${out}`);

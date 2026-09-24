// The six research objectives are shared by every study. Each study decides
// which questionnaire-based KPIs belong to them; a missing measure stays empty.
const OBJECTIVES = Object.freeze([
  { key: 'who', label: 'Who', description: 'Who is consuming across groups and places.' },
  { key: 'what', label: 'What', description: 'Products, brands and consumption formats.' },
  { key: 'where_when', label: 'Where & When', description: 'Places, occasions and timing.' },
  { key: 'why', label: 'Why', description: 'Reasons behind product and brand choices.' },
  { key: 'influencing_factors', label: 'Influencing Factors', description: 'Reported drivers of a choice.' },
  { key: 'performance', label: 'Performance', description: 'Category and brand results across contexts.' },
]);

const OBJECTIVE_KEYS = new Set(OBJECTIVES.map(objective => objective.key));

function objectiveGroups(kpis) {
  return OBJECTIVES.map(objective => ({
    ...objective,
    kpis: kpis.filter(kpi => kpi.enabled && kpi.objective_key === objective.key),
  }));
}

module.exports = { OBJECTIVES, OBJECTIVE_KEYS, objectiveGroups };

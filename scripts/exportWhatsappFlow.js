// Export the respondent-diary portion of a published questionnaire as Meta
// WhatsApp Flow JSON.
//
// Usage: node scripts/exportWhatsappFlow.js <study-id> [output.json]

require("dotenv").config();

const fs = require("node:fs/promises");
const path = require("node:path");
const store = require("../lib/store");
const { loadQuestionnaire } = require("../lib/questionnaire");
const { compileFlow } = require("../lib/whatsappFlow");

async function main() {
  const studyId = Number(process.argv[2]);
  const outputPath = process.argv[3] ? path.resolve(process.argv[3]) : null;
  if (!Number.isInteger(studyId) || studyId < 1) {
    throw new Error("Usage: node scripts/exportWhatsappFlow.js <study-id> [output.json]");
  }

  await store.connect();
  try {
    const study = await store.findOne("studies", { id: studyId });
    if (!study) throw new Error("Study not found: " + studyId);
    const questionnaire = await loadQuestionnaire(study.id, { respondentId: 0 });
    const compiled = compileFlow({ study, questionnaire });
    const json = JSON.stringify(compiled.flow, null, 2) + "\n";

    if (outputPath) {
      await fs.writeFile(outputPath, json, "utf8");
      process.stdout.write("Wrote " + outputPath + "\n");
    } else {
      process.stdout.write(json);
    }
    process.stderr.write(
      "Study " + study.id + " questionnaire v" + compiled.questionnaireVersion +
      ": " + compiled.includedQuestionIds.length + " Flow questions, " +
      compiled.fallbackQuestionIds.length + " chat questions.\n"
    );
    for (const warning of compiled.warnings) process.stderr.write("- " + warning + "\n");
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  process.stderr.write("FAILED: " + error.message + "\n");
  process.exitCode = 1;
});

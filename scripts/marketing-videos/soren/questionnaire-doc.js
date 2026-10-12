// Writes .work/soren/morning-drink-questionnaire.docx: the Level 1 questionnaire in Soren's
// import template columns (# | Question | Type | Options | Section | Condition), uploaded on
// camera through "Generate with AI → Import from a file". Converted from HTML by LibreOffice.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { WORK } = require('../config');
const { PROJECT, QUESTIONNAIRE_LEVEL, QUESTIONS } = require('./content');

const dir = path.join(WORK, 'soren');
fs.mkdirSync(dir, { recursive: true });
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const cell = 'border:1px solid #888;padding:4px 6px;font-family:Arial;font-size:10pt;vertical-align:top';
const rows = QUESTIONS.map((q, i) => `<tr><td style="${cell}">Q${i + 1}</td>${q.map((v) => `<td style="${cell}">${esc(v)}</td>`).join('')}</tr>`).join('\n');
const html = `<html><head><meta charset="utf-8"></head><body style="font-family:Arial">
<h2>${esc(PROJECT.title)}: ${esc(QUESTIONNAIRE_LEVEL)}</h2>
<p style="font-size:10pt">Soren questionnaire import template.</p>
<table style="border-collapse:collapse">
<tr>${['#', 'Question', 'Type', 'Options', 'Section', 'Condition'].map((h) => `<th style="${cell};background:#dde6f0">${h}</th>`).join('')}</tr>
${rows}
</table></body></html>`;

const name = 'morning-drink-questionnaire';
fs.writeFileSync(path.join(dir, `${name}.html`), html);
execFileSync('libreoffice', ['--headless', '--convert-to', 'docx:MS Word 2007 XML', '--outdir', dir, path.join(dir, `${name}.html`)], { stdio: 'inherit' });
console.log(`${QUESTIONS.length} questions -> ${path.join(dir, `${name}.docx`)}`);

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const api = require('../lib/openaiClient');
const ai = require('../lib/aiSummary');
let originalFetch, originalEnv;
const completed = text => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] });
before(() => {
  originalFetch = global.fetch;
  originalEnv = { AI_SUMMARY_PROVIDER: process.env.AI_SUMMARY_PROVIDER, OPENAI_API_KEY: process.env.OPENAI_API_KEY, OPENAI_SUMMARY_MODEL: process.env.OPENAI_SUMMARY_MODEL };
  process.env.AI_SUMMARY_PROVIDER = 'openai'; process.env.OPENAI_API_KEY = 'test-openai-key'; delete process.env.OPENAI_SUMMARY_MODEL;
});
after(() => {
  global.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
test('OpenAI selection requires its own key and preserves the other providers', () => {
  assert.equal(ai.providerName(), 'openai'); assert.equal(ai.providerLabel(), 'OpenAI');
  assert.equal(ai.getProvider().model, 'gpt-5.4-mini');
  process.env.OPENAI_SUMMARY_MODEL = 'custom-openai-model'; assert.equal(ai.getProvider().model, 'custom-openai-model'); delete process.env.OPENAI_SUMMARY_MODEL;
  delete process.env.OPENAI_API_KEY; assert.equal(ai.isAiModelConfigured(), false); assert.throws(() => ai.getProvider(), /OPENAI_API_KEY/);
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.AI_SUMMARY_PROVIDER = 'gemini'; assert.equal(ai.providerName(), 'gemini');
  process.env.AI_SUMMARY_PROVIDER = 'azure_openai'; assert.equal(ai.providerName(), 'openai', 'the retired Azure OpenAI setting means OpenAI');
  delete process.env.AI_SUMMARY_PROVIDER; assert.equal(ai.providerName(), 'openai');
  process.env.AI_SUMMARY_PROVIDER = 'openai';
});
test('Responses API request preserves system/input, uses bearer auth and opts out of storage', async () => {
  let request;
  global.fetch = async (url, options) => { request = { url, ...options, body: JSON.parse(options.body) }; return new Response(JSON.stringify(completed('{"findings":[]}'))); };
  const text = await ai.getProvider().complete({ system: 'Use evidence only. Return JSON.', prompt: 'provided evidence', maxTokens: 6000, json: true });
  assert.equal(text, '{"findings":[]}');
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.headers.Authorization, 'Bearer test-openai-key');
  assert.equal(request.body.instructions, 'Use evidence only. Return JSON.'); assert.equal(request.body.input, 'provided evidence');
  assert.equal(request.body.store, false); assert.equal(request.body.max_output_tokens, 6000);
  assert.deepEqual(request.body.text, { format: { type: 'json_object' } });
  assert.ok(request.signal); assert.equal('temperature' in request.body, false);
});
test('study narratives and themes use OpenAI with their existing output contracts', async () => {
  const bodies = [];
  global.fetch = async (_, options) => {
    const body = JSON.parse(options.body); bodies.push(body);
    return new Response(JSON.stringify(completed(body.text ? '{"themes":[{"name":"Preparation","mentions":1,"sentiment":"positive","example":"Easy to cook"}],"overall_sentiment":{"positive":100,"neutral":0,"negative":0}}' : 'The recorded meal was easy to prepare.')));
  };
  const provider = ai.getProvider();
  assert.match(await provider.summarize({ metrics: { base: 1 }, openText: [{ answer: 'Easy to cook' }] }), /easy to prepare/);
  assert.deepEqual(JSON.parse(bodies[0].input).metrics, { base: 1 }); assert.equal(bodies[0].text, undefined);
  const themes = await provider.analyzeThemes({ openText: [{ answer: 'Easy to cook' }] });
  assert.equal(themes.themes[0].name, 'Preparation'); assert.equal(themes.overallSentiment.positive, 100);
});
test('extracts text from message outputs, and rejects partial, refused and empty responses', () => {
  assert.equal(api.outputText({ status: 'completed', output: [{ type: 'reasoning' }, ...completed('First').output, ...completed('Second').output] }), 'First\nSecond');
  assert.throws(() => api.outputText({ ...completed('partial answer'), status: 'incomplete' }), /did not complete/);
  assert.throws(() => api.outputText({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No' }] }] }), /could not produce/);
  assert.throws(() => api.outputText(completed('')), /empty/);
});
test('transient OpenAI errors retry without calling Gemini', async () => {
  let calls = 0;
  global.fetch = async url => {
    assert.equal(url, 'https://api.openai.com/v1/responses'); calls++;
    return calls === 1 ? new Response('upstream unavailable', { status: 503 }) : new Response(JSON.stringify(completed('Recovered summary')));
  };
  assert.equal(await ai.getProvider().complete({ system: 'Summarise.', prompt: 'Evidence' }), 'Recovered summary'); assert.equal(calls, 2);
});
test('authentication and quota failures fail once without exposing response bodies or keys', async () => {
  for (const [status, code] of [[401, 'invalid_api_key'], [429, 'insufficient_quota']]) {
    let calls = 0;
    global.fetch = async () => { calls++; return new Response(JSON.stringify({ error: { code, message: 'private details test-openai-key' } }), { status }); };
    await assert.rejects(ai.getProvider().complete({ system: 'Summarise.', prompt: 'Evidence' }), error => { assert.equal(error.status, status); assert.doesNotMatch(error.message, /private details|test-openai-key/); return true; });
    assert.equal(calls, 1);
  }
});

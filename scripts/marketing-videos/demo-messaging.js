// Demo-only preload (node -r), used by serve.sh and never by the real app.
// The demo server runs with mock messaging, which records messages but makes
// the app say "nothing was delivered". For recordings we want the screens a
// connected deployment shows, so this wraps the mock provider to report a
// successful send, and writes each message to .work/inbox.jsonl -- a fake
// phone inbox the recorder reads verification codes from.
const fs = require('fs');
const path = require('path');
const { APP, WORK } = require('./config');

const messaging = require(path.join(APP, 'lib', 'whatsapp'));
const realGetProvider = messaging.getProvider;
messaging.getProvider = function demoProvider() {
  const provider = realGetProvider.apply(this, arguments);
  const send = provider.send.bind(provider);
  provider.send = async (message) => {
    const result = await send(message);
    fs.mkdirSync(WORK, { recursive: true });
    fs.appendFileSync(path.join(WORK, 'inbox.jsonl'), JSON.stringify({ at: new Date().toISOString(), to: message.to, template: message.template, variables: message.variables }) + '\n');
    return result && result.ok ? { ...result, simulated: false } : result;
  };
  return provider;
};
messaging.isRealMessagingConfigured = () => true;

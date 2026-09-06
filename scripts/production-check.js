// Read-only readiness check. Never prints credential values or connects to services.
require('dotenv').config();
const checks=[
 ['Persistent database',!!process.env.MONGODB_URI],
 ['Session secret (at least 32 characters)',(process.env.SESSION_SECRET||'').length>=32],
 ['Private durable media provider',process.env.STORAGE_PROVIDER==='azure_blob'],
 ['Azure media connection configured',!!process.env.AZURE_STORAGE_CONNECTION_STRING],
 ['Azure media read signing configured',!!process.env.AZURE_STORAGE_ACCOUNT_NAME&&!!process.env.AZURE_STORAGE_ACCOUNT_KEY],
 ['Production runtime',process.env.NODE_ENV==='production'],
 ['TLS public URL',/^https:\/\//.test(process.env.PUBLIC_BASE_URL||process.env.APP_BASE_URL||'')],
];
for(const [label,ok]of checks)process.stdout.write(`${ok?'PASS':'CHECK'} ${label}\n`);
process.stdout.write('Managed backups, restore drills, blob versioning, retention approval and external monitoring require operational evidence.\n');
process.exitCode=checks.every(([,ok])=>ok)?0:1;

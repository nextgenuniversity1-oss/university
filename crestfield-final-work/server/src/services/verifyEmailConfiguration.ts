import { verifyEmailConfiguration } from './email.js';

const result = await verifyEmailConfiguration();
console.log(JSON.stringify({
  verified: result.verified,
  status: result.status,
  code: result.code,
  message: result.message,
  issues: result.issues,
  warnings: result.warnings,
}, null, 2));

if (!result.verified) process.exitCode = 1;
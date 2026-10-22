import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseSmtpConfiguration } from '../config/env.js';
import { allowRoles } from '../middleware/auth.js';
import { createActivationConsumptionUpdate, createActivationToken, ACTIVATION_TOKEN_TTL_MS } from './activationTokens.js';
import { classifyEmailErrorForTests, getEmailConfigurationStatus, getSmtpTransportOptions, sendEmail, setMailTransportFactoryForTests, verifyEmailConfiguration } from './email.js';
import { createAndDeliverStaffInvitation, isDuplicateStaffAccountError } from './staffInvitation.js';

const gmailValues = {
  SMTP_HOST: ' smtp.gmail.com ',
  SMTP_PORT: '587',
  SMTP_USER: 'test-account@gmail.com',
  SMTP_PASSWORD: ' ab cd ef gh ij kl mn op ',
  SMTP_SECURE: 'false',
  SMTP_FROM: 'test-account@gmail.com',
};

function validGmailConfiguration(port = '587', secure = port === '465' ? 'true' : 'false') {
  return parseSmtpConfiguration({ ...gmailValues, SMTP_PORT: port, SMTP_SECURE: secure });
}

test('Gmail 587 normalizes whitespace and requires STARTTLS', () => {
  const configuration = validGmailConfiguration();
  assert.equal(configuration.status, 'configured');
  assert.equal(configuration.password.includes(' '), false);
  assert.equal(configuration.password.length, 16);
  const options = getSmtpTransportOptions(configuration);
  assert.deepEqual({ host: options.host, port: options.port, secure: options.secure, requireTLS: options.requireTLS, user: options.auth.user, passwordLength: options.auth.pass.length }, {
    host: 'smtp.gmail.com', port: 587, secure: false, requireTLS: true, user: 'test-account@gmail.com', passwordLength: 16,
  });
});

test('port 465 uses implicit TLS without STARTTLS requirement', () => {
  const options = getSmtpTransportOptions(validGmailConfiguration('465'));
  assert.equal(options.port, 465);
  assert.equal(options.secure, true);
  assert.equal(options.requireTLS, false);
});

test('missing SMTP settings are distinguished from malformed settings', () => {
  const missing = parseSmtpConfiguration({ SMTP_PORT: '587', SMTP_SECURE: 'false' });
  assert.equal(missing.status, 'missing');
  assert.equal(missing.code, 'SMTP_NOT_CONFIGURED');
  const invalid = parseSmtpConfiguration({ ...gmailValues, SMTP_PORT: 'not-a-port' });
  assert.equal(invalid.status, 'invalid');
  assert.match(invalid.message, /SMTP_PORT/);
  assert.equal(parseSmtpConfiguration({ ...gmailValues, SMTP_PORT: '587', SMTP_SECURE: 'true' }).status, 'invalid');
  assert.equal(parseSmtpConfiguration({ ...gmailValues, SMTP_PORT: '465', SMTP_SECURE: 'false' }).status, 'invalid');
});

test('Gmail sender placeholders and sender mismatch are reported safely', () => {
  const invalid = parseSmtpConfiguration({ ...gmailValues, SMTP_FROM: 'no-reply@university.local' });
  assert.equal(invalid.status, 'invalid');
  assert.match(invalid.message, /real sender email/);
  const warning = parseSmtpConfiguration({ ...gmailValues, SMTP_FROM: 'other@example.com' });
  assert.equal(warning.status, 'configured');
  assert.ok(warning.warnings.length);
});

test('SMTP verification and send use mocked provider acceptance only', async () => {
  let verifyCount = 0;
  let sendCount = 0;
  setMailTransportFactoryForTests(() => ({
    verify: async () => { verifyCount += 1; return true; },
    sendMail: async () => { sendCount += 1; return { accepted: ['staff@example.com'], rejected: [], messageId: 'mock-message-id' }; },
  }) as any, validGmailConfiguration());
  const verification = await verifyEmailConfiguration();
  assert.equal(verification.verified, true);
  assert.match(verification.message, /does not confirm delivery/);
  assert.equal((await sendEmail('staff@example.com', 'Invite', 'Activate')).delivered, true);
  assert.equal(verifyCount, 1);
  assert.equal(sendCount, 1);
  setMailTransportFactoryForTests();
});

test('missing and invalid configuration prevent transport creation', async () => {
  let factoryCalls = 0;
  setMailTransportFactoryForTests(() => { factoryCalls += 1; throw new Error('must not create transport'); }, parseSmtpConfiguration({}));
  const missing = await sendEmail('staff@example.com', 'Invite', 'Activate');
  assert.equal(missing.delivered, false);
  if (!missing.delivered) assert.equal(missing.code, 'EMAIL_NOT_CONFIGURED');
  assert.deepEqual(Object.keys(getEmailConfigurationStatus()).sort(), ['code','issues','message','status','warnings']);
  setMailTransportFactoryForTests(undefined, parseSmtpConfiguration({ ...gmailValues, SMTP_PORT: 'bad' }));
  const invalid = await sendEmail('staff@example.com', 'Invite', 'Activate');
  assert.equal(invalid.delivered, false);
  if (!invalid.delivered) assert.equal(invalid.code, 'EMAIL_CONFIG_INVALID');
  assert.equal(factoryCalls, 0);
  setMailTransportFactoryForTests();
});

test('SMTP errors are categorized without returning provider messages or secrets', () => {
  const auth = classifyEmailErrorForTests({ code: 'EAUTH', responseCode: 535, message: 'mock secret rejected' });
  assert.equal(auth.code, 'EMAIL_AUTH_FAILED');
  assert.equal(JSON.stringify(auth).includes('mock secret rejected'), false);
  assert.equal(classifyEmailErrorForTests({ code: 'ETIMEDOUT' }).code, 'EMAIL_CONNECTION_TIMEOUT');
  assert.equal(classifyEmailErrorForTests({ code: 'ECONNREFUSED' }).code, 'EMAIL_NETWORK_FAILED');
  assert.equal(classifyEmailErrorForTests({ code: 'EENVELOPE', command: 'MAIL FROM', responseCode: 550 }).code, 'EMAIL_SENDER_REJECTED');
  assert.equal(classifyEmailErrorForTests({ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550 }).code, 'EMAIL_RECIPIENT_REJECTED');
  assert.equal(classifyEmailErrorForTests({ code: 'EMESSAGE', responseCode: 421 }).code, 'EMAIL_PROVIDER_REJECTED');
  assert.equal(classifyEmailErrorForTests({ code: 'ETLS' }).code, 'EMAIL_TLS_FAILED');
});

test('verification and send failures return sanitized auth, timeout, and provider diagnostics', async () => {
  setMailTransportFactoryForTests(() => ({
    verify: async () => { throw { code: 'EAUTH', responseCode: 535, message: 'mock private password rejected' }; },
    sendMail: async () => { throw { code: 'ETIMEDOUT', message: 'mock private recipient data' }; },
  }) as any, validGmailConfiguration());
  const verification = await verifyEmailConfiguration();
  assert.equal(verification.verified, false);
  assert.equal(verification.code, 'EMAIL_AUTH_FAILED');
  assert.equal(JSON.stringify(verification).includes('mock private password'), false);
  const timeout = await sendEmail('staff@example.com', 'Invite', 'Activation link');
  assert.equal(timeout.delivered, false);
  if (!timeout.delivered) {
    assert.equal(timeout.code, 'EMAIL_CONNECTION_TIMEOUT');
    assert.equal(timeout.reason.includes('mock private recipient'), false);
  }

  setMailTransportFactoryForTests(() => ({
    verify: async () => true,
    sendMail: async () => { throw { code: 'EMESSAGE', responseCode: 421, message: 'mock provider throttle details' }; },
  }) as any, validGmailConfiguration());
  const rejected = await sendEmail('staff@example.com', 'Invite', 'Activation link');
  assert.equal(rejected.delivered, false);
  if (!rejected.delivered) assert.equal(rejected.code, 'EMAIL_PROVIDER_REJECTED');
  setMailTransportFactoryForTests();
});

test('unaccepted recipient is not reported as delivered', async () => {
  setMailTransportFactoryForTests(() => ({ verify: async () => true, sendMail: async () => ({ accepted: [], rejected: ['staff@example.com'] }) }) as any, validGmailConfiguration());
  const result = await sendEmail('staff@example.com', 'Invite', 'Activate');
  assert.equal(result.delivered, false);
  if (!result.delivered) assert.equal(result.code, 'EMAIL_RECIPIENT_REJECTED');
  setMailTransportFactoryForTests();
});

test('staff invitation removes pending account on failure and keeps it after acceptance', async () => {
  const failureOrder: string[] = [];
  let retainedAccount = false;
  const failed = await createAndDeliverStaffInvitation({
    createPending: async () => { failureOrder.push('create'); retainedAccount = true; return { id: 'pending' }; },
    send: async () => { failureOrder.push('send'); return { delivered: false, code: 'EMAIL_AUTH_FAILED', reason: 'Check App Password.' }; },
    removePending: async () => { failureOrder.push('remove'); retainedAccount = false; return true; },
  });
  assert.deepEqual(failureOrder, ['create','send','remove']);
  assert.equal(failed.delivered, false);
  assert.equal(retainedAccount, false);
  if (!failed.delivered) assert.equal(failed.cleanupFailed, false);

  const successOrder: string[] = [];
  const delivered = await createAndDeliverStaffInvitation({
    createPending: async () => { successOrder.push('create'); retainedAccount = true; return { id: 'pending' }; },
    send: async () => { successOrder.push('send'); return { delivered: true, messageId: 'mock' }; },
    removePending: async () => { successOrder.push('remove'); return true; },
  });
  assert.deepEqual(successOrder, ['create','send']);
  assert.equal(delivered.delivered, true);
  assert.equal(retainedAccount, true);

  const cleanupFailed = await createAndDeliverStaffInvitation({
    createPending: async () => ({ id: 'pending' }),
    send: async () => ({ delivered: false, code: 'EMAIL_AUTH_FAILED', reason: 'Check App Password.' }),
    removePending: async () => false,
  });
  assert.equal(cleanupFailed.delivered, false);
  if (!cleanupFailed.delivered) assert.equal(cleanupFailed.cleanupFailed, true);
});

test('duplicate submissions are recognized as conflicts for safe retry guidance', () => {
  assert.equal(isDuplicateStaffAccountError({ code: 11000 }), true);
  assert.equal(isDuplicateStaffAccountError({ code: 'EMAIL_AUTH_FAILED' }), false);
  assert.equal(isDuplicateStaffAccountError(new Error('unrelated')), false);
});

test('activation token is hashed, expires after 24 hours, and is consumed atomically once', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const token = createActivationToken(now);
  assert.equal(Buffer.from(token.rawToken, 'base64url').length, 32);
  assert.equal(token.tokenHash, createHash('sha256').update(token.rawToken).digest('hex'));
  assert.equal(token.tokenHash.includes(token.rawToken), false);
  assert.equal(token.expiresAt.getTime() - now.getTime(), ACTIVATION_TOKEN_TTL_MS);
  const consume = createActivationConsumptionUpdate(token.rawToken, 'hashed-password', now);
  assert.deepEqual(consume.filter, { activationTokenHash: token.tokenHash, activationExpiresAt: { $gt: now }, status: 'PENDING' });
  assert.deepEqual(consume.update.$unset, { activationTokenHash: 1, activationExpiresAt: 1 });
  assert.equal(consume.filter.activationExpiresAt.$gt.getTime() < token.expiresAt.getTime(), true);
});

test('role authorization rejects a non-Super-Admin creator', () => {
  let status = 0;
  let nextCalled = false;
  const response = { status(code: number) { status = code; return this; }, json() { return this; } };
  allowRoles('SUPER_ADMIN')({ user: { role: 'REGISTRAR' } } as any, response as any, () => { nextCalled = true; });
  assert.equal(status, 403);
  assert.equal(nextCalled, false);
});
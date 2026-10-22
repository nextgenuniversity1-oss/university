import nodemailer from 'nodemailer';
import { env, type SmtpConfiguration } from '../config/env.js';

type DeliveryErrorCode = 'EMAIL_NOT_CONFIGURED' | 'EMAIL_CONFIG_INVALID' | 'EMAIL_AUTH_FAILED' | 'EMAIL_CONNECTION_TIMEOUT' | 'EMAIL_NETWORK_FAILED' | 'EMAIL_TLS_FAILED' | 'EMAIL_SENDER_REJECTED' | 'EMAIL_RECIPIENT_REJECTED' | 'EMAIL_PROVIDER_REJECTED' | 'EMAIL_DELIVERY_FAILED';
export type EmailResult = { delivered: true; messageId?: string } | { delivered: false; code: DeliveryErrorCode; reason: string };
type MailTransport = Pick<nodemailer.Transporter, 'sendMail' | 'verify'>;
type TransportFactory = (configuration: SmtpConfiguration) => MailTransport;

export function getSmtpTransportOptions(configuration: SmtpConfiguration) {
  return {
    host: configuration.host,
    port: configuration.port!,
    secure: configuration.secure!,
    requireTLS: configuration.secure === false,
    auth: { user: configuration.user, pass: configuration.password },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  };
}

function createTransport(configuration: SmtpConfiguration): MailTransport {
  return nodemailer.createTransport(getSmtpTransportOptions(configuration));
}

let factory: TransportFactory = createTransport;
let smtpConfiguration: SmtpConfiguration = env.smtp;
let cachedTransport: MailTransport | null = null;
function transport(): MailTransport | null {
  if (smtpConfiguration.status !== 'configured') return null;
  if (!cachedTransport) cachedTransport = factory(smtpConfiguration);
  return cachedTransport;
}

function classifyError(error: unknown): { code: DeliveryErrorCode; reason: string; technicalCode?: string; responseCode?: number } {
  const safeError = error && typeof error === 'object' ? error as { code?: unknown; responseCode?: unknown; command?: unknown } : {};
  const technicalCode = typeof safeError.code === 'string' ? safeError.code : '';
  const responseCode = typeof safeError.responseCode === 'number' ? safeError.responseCode : undefined;
  const command = typeof safeError.command === 'string' ? safeError.command.toUpperCase() : '';
  if (responseCode === 535 || /EAUTH|AUTH/.test(technicalCode)) return { code: 'EMAIL_AUTH_FAILED', reason: 'Email authentication failed. Check SMTP_USER and the Gmail App Password.', technicalCode, responseCode };
  if (responseCode && responseCode >= 400 && /MAIL FROM/.test(command)) return { code: 'EMAIL_SENDER_REJECTED', reason: 'The email provider rejected the sender address. Check SMTP_FROM and Gmail send-as settings.', technicalCode, responseCode };
  if (responseCode && responseCode >= 400 && /RCPT TO/.test(command)) return { code: 'EMAIL_RECIPIENT_REJECTED', reason: 'The email provider rejected the recipient address. Check that address and try again.', technicalCode, responseCode };
  if (responseCode === 421 || responseCode === 450 || responseCode === 451 || responseCode === 452 || responseCode === 454 || responseCode === 550 || responseCode === 552 || responseCode === 554) return { code: 'EMAIL_PROVIDER_REJECTED', reason: 'The email provider rejected the message or is rate limiting delivery. Review server diagnostics and try again later.', technicalCode, responseCode };
  if (/ETIMEDOUT|ESOCKETTIMEDOUT|ETLS/.test(technicalCode)) return { code: technicalCode === 'ETLS' ? 'EMAIL_TLS_FAILED' : 'EMAIL_CONNECTION_TIMEOUT', reason: technicalCode === 'ETLS' ? 'The SMTP TLS/STARTTLS negotiation failed. Check the host, port, and SMTP_SECURE setting.' : 'The SMTP connection timed out. Check network access and the SMTP host and port.', technicalCode, responseCode };
  if (/CERT|TLS|SSL/.test(technicalCode)) return { code: 'EMAIL_TLS_FAILED', reason: 'The SMTP TLS/STARTTLS negotiation failed. Check the host, port, and SMTP_SECURE setting.', technicalCode, responseCode };
  if (/ECONN|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH/.test(technicalCode)) return { code: 'EMAIL_NETWORK_FAILED', reason: 'The SMTP server could not be reached. Check DNS, firewall, network access, and SMTP_HOST.', technicalCode, responseCode };
  return { code: 'EMAIL_DELIVERY_FAILED', reason: 'The email could not be sent. Check the server logs for sanitized diagnostic details.', technicalCode: technicalCode || undefined, responseCode };
}

function logDiagnostic(event: string, error: unknown) {
  const diagnostic = classifyError(error);
  console.error('SMTP diagnostic', { event, code: diagnostic.code, smtpCode: diagnostic.technicalCode, responseCode: diagnostic.responseCode });
  return diagnostic;
}

export function getEmailConfigurationStatus() {
  return { status: smtpConfiguration.status, code: smtpConfiguration.code, message: smtpConfiguration.message, issues: smtpConfiguration.issues, warnings: smtpConfiguration.warnings };
}

export async function verifyEmailConfiguration() {
  if (smtpConfiguration.status === 'missing') return { ...getEmailConfigurationStatus(), verified: false };
  if (smtpConfiguration.status === 'invalid') return { ...getEmailConfigurationStatus(), verified: false };
  try {
    await transport()!.verify();
    return { ...getEmailConfigurationStatus(), verified: true, message: 'SMTP connection and authentication verified. This does not confirm delivery to any recipient.' };
  } catch (error) {
    const diagnostic = logDiagnostic('verify', error);
    return { ...getEmailConfigurationStatus(), status: 'unreachable' as const, verified: false, code: diagnostic.code, message: diagnostic.reason };
  }
}

export async function sendEmail(to: string, subject: string, text: string): Promise<EmailResult> {
  if (smtpConfiguration.status === 'missing') return { delivered: false, code: 'EMAIL_NOT_CONFIGURED', reason: smtpConfiguration.message };
  if (smtpConfiguration.status === 'invalid') return { delivered: false, code: 'EMAIL_CONFIG_INVALID', reason: smtpConfiguration.message };
  try {
    const info = await transport()!.sendMail({ from: env.smtp.from, to, subject, text });
    if (!info.accepted?.length || info.rejected?.length) return { delivered: false, code: 'EMAIL_RECIPIENT_REJECTED', reason: 'The email provider did not accept the recipient address.' };
    return { delivered: true, messageId: info.messageId };
  } catch (error) {
    const diagnostic = logDiagnostic('send', error);
    return { delivered: false, code: diagnostic.code, reason: diagnostic.reason };
  }
}

export function setMailTransportFactoryForTests(testFactory?: TransportFactory, testConfiguration?: SmtpConfiguration) {
  factory = testFactory || createTransport;
  smtpConfiguration = testConfiguration || env.smtp;
  cachedTransport = null;
}

export function classifyEmailErrorForTests(error: unknown) {
  return classifyError(error);
}
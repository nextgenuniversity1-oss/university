import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });
export type SmtpConfiguration = {
  status: 'missing' | 'invalid' | 'configured';
  code: 'SMTP_NOT_CONFIGURED' | 'SMTP_CONFIG_INVALID' | null;
  message: string;
  issues: string[];
  warnings: string[];
  host: string;
  port: number | null;
  secure: boolean | null;
  user: string;
  password: string;
  from: string;
};

export function parseSmtpConfiguration(source: Readonly<Record<string, string | undefined>>): SmtpConfiguration {
  const host = (source.SMTP_HOST || '').trim().toLowerCase();
  const portText = (source.SMTP_PORT || '').trim();
  const user = (source.SMTP_USER || '').trim();
  const rawPassword = (source.SMTP_PASSWORD || '').trim();
  const secureText = (source.SMTP_SECURE || '').trim().toLowerCase();
  const from = (source.SMTP_FROM || '').trim();
  const base = { host, port: null, secure: null, user, password: rawPassword, from, issues: [], warnings: [] as string[] } as const;
  if ([host, user, rawPassword, from].every(value => !value)) return { ...base, status: 'missing', code: 'SMTP_NOT_CONFIGURED', message: 'SMTP is not configured. Set all required SMTP_* values in server/.env.', issues: [] };

  const issues: string[] = [];
  if (!host) issues.push('SMTP_HOST is required.');
  else if (!/^[a-z0-9.-]+$/.test(host)) issues.push('SMTP_HOST must be a valid hostname.');
  const port = /^\d+$/.test(portText) ? Number(portText) : NaN;
  if (!portText) issues.push('SMTP_PORT is required.');
  else if (!Number.isInteger(port) || port < 1 || port > 65535) issues.push('SMTP_PORT must be an integer from 1 to 65535.');
  if (!user) issues.push('SMTP_USER is required.');
  if (!rawPassword) issues.push('SMTP_PASSWORD is required.');
  if (!from) issues.push('SMTP_FROM is required.');
  const secure = secureText === 'true' ? true : secureText === 'false' ? false : null;
  if (secure === null) issues.push('SMTP_SECURE must be either true or false.');
  const senderAddress = from.match(/<\s*([^<>]+)\s*>/)?.[1]?.trim() || from;
  if (from && (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(senderAddress) || /\.(local|localhost)$/i.test(senderAddress.split('@').pop() || ''))) {
    issues.push('SMTP_FROM must be a real sender email address accepted by your provider; local placeholder domains are not valid senders.');
  }
  if (port === 587 && secure === true) issues.push('Port 587 requires SMTP_SECURE=false so the connection can use STARTTLS.');
  if (port === 465 && secure === false) issues.push('Port 465 requires SMTP_SECURE=true for implicit TLS.');
  if (host === 'smtp.gmail.com' && user && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user)) issues.push('SMTP_USER must be the Gmail or Google Workspace account email.');
  const warnings = host === 'smtp.gmail.com' && senderAddress && senderAddress.toLowerCase() !== user.toLowerCase()
    ? ['Gmail accepts SMTP_FROM only when it matches SMTP_USER or is configured as a verified Gmail send-as alias.']
    : [];
  if (issues.length) return { ...base, status: 'invalid', code: 'SMTP_CONFIG_INVALID', message: issues.join(' '), issues, warnings, port: Number.isFinite(port) ? port : null, secure };
  const password = host === 'smtp.gmail.com' ? rawPassword.replace(/ /g, '') : rawPassword;
  return { ...base, status: 'configured', code: null, message: 'SMTP settings are present and structurally valid.', issues: [], warnings, port, secure, password };
}

const nodeEnv = process.env.NODE_ENV || 'development';
const jwtSecret = process.env.JWT_SECRET || 'development-only-change-this-secret-before-deploying';
if (nodeEnv === 'production' && (!process.env.JWT_SECRET || jwtSecret.length < 32)) {
  throw new Error('Production requires a JWT_SECRET of at least 32 characters.');
}
export const env = {
  port: Number(process.env.PORT || 4000),
  nodeEnv,
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/university_management_system',
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  smtp: parseSmtpConfiguration(process.env),
  paystackSecretKey: process.env.PAYSTACK_SECRET_KEY || '',
  paystackBaseUrl: process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co',
  cloudinaryCloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
  cloudinaryApiKey: process.env.CLOUDINARY_API_KEY || '',
  cloudinaryApiSecret: process.env.CLOUDINARY_API_SECRET || '',
};

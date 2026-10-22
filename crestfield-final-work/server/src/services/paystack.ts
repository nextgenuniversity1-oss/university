import { env } from '../config/env.js';
export async function initializePaystackPayment(email: string, amountKobo: number, reference: string, metadata: Record<string, unknown> = {}, callbackUrl?: string) {
  if (!env.paystackSecretKey) throw new Error('Paystack is not configured. Set PAYSTACK_SECRET_KEY on the server.');
  const response = await fetch(`${env.paystackBaseUrl}/transaction/initialize`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.paystackSecretKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, amount: amountKobo, reference, metadata, callback_url: callbackUrl || `${env.clientOrigin.replace(/\/$/, '')}/admissions` }),
  });
  const result = await response.json() as { status?: boolean; message?: string; data?: unknown };
  if (!response.ok || !result.status) throw new Error(result.message || 'Could not initialize payment.');
  return result.data;
}
export async function verifyPaystackPayment(reference: string) {
  if (!env.paystackSecretKey) throw new Error('Paystack is not configured.');
  const response = await fetch(`${env.paystackBaseUrl}/transaction/verify/${encodeURIComponent(reference)}`, { headers: { Authorization: `Bearer ${env.paystackSecretKey}` } });
  const result = await response.json() as { status?: boolean; message?: string; data?: { status?: string; reference?: string; amount?: number; currency?: string } };
  if (!response.ok || !result.status || result.data?.status !== 'success') throw new Error(result.message || 'Payment could not be verified.');
  return result.data;
}

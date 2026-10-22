import { Router, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authenticate, allowRoles } from '../middleware/auth.js';
import { initializePaystackPayment, verifyPaystackPayment } from '../services/paystack.js';
import { RecordModel } from '../models/Record.js';
import { audit } from '../services/audit.js';
const router = Router();

// Paystack signs the exact raw request bytes. Never trust browser redirects or unsigned webhook bodies.
router.post('/webhook', async (req: Request & { rawBody?: Buffer }, res: Response, next) => {
 try {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  const signature = req.header('x-paystack-signature');
  if (!secret || !signature || !req.rawBody) return res.status(401).json({ message:'Invalid payment webhook signature.' });
  const expected = createHmac('sha512', secret).update(req.rawBody).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(signature, 'hex'); } catch { return res.status(401).json({ message:'Invalid payment webhook signature.' }); }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return res.status(401).json({ message:'Invalid payment webhook signature.' });
  const event = req.body as { event?: string; data?: { status?: string; reference?: string; amount?: number; currency?: string } };
  if (event.event !== 'charge.success' || !event.data?.reference || event.data.status !== 'success') return res.status(200).json({ received:true, ignored:true });
  const reference = event.data.reference;
  const record = await RecordModel.findOne({ module:'finance', reference, 'data.applicationFee':true });
  if (!record) return res.status(200).json({ received:true, ignored:true });
  const expectedKobo = Math.round(Number((record.data as any).amountNaira) * 100);
  if (event.data.currency !== 'NGN' || !Number.isFinite(expectedKobo) || event.data.amount !== expectedKobo) {
   const exceptionRef=`PAYMENT:${reference}`;
   if(!await RecordModel.findOne({module:'finance-exceptions',reference:exceptionRef,status:'OPEN'})) await RecordModel.create({module:'finance-exceptions',title:`Payment webhook mismatch: ${reference}`,status:'OPEN',reference:exceptionRef,ownerId:record.ownerId,createdBy:record.createdBy,data:{paymentRecordId:String(record._id),paymentReference:reference,expectedKobo,actualKobo:event.data.amount,actualCurrency:event.data.currency,detectedAt:new Date(),exceptionType:'WEBHOOK_AMOUNT_OR_CURRENCY_MISMATCH'}});
   return res.status(200).json({ received:true, ignored:true, reason:'amount_or_currency_mismatch', exceptionOpened:true });
  }
  if (record.status === 'PAYMENT_VERIFIED') return res.status(200).json({ received:true, idempotentReplay:true });
  if (record.status !== 'PAYMENT_INITIALIZED') return res.status(200).json({ received:true, ignored:true, reason:'payment_not_pending' });
  const updated = await RecordModel.findOneAndUpdate(
   { _id:record._id, status:'PAYMENT_INITIALIZED', 'data.applicationFee':true },
   { $set:{ status:'PAYMENT_VERIFIED', 'data.verifiedAmountKobo':event.data.amount, 'data.currency':event.data.currency, 'data.verifiedAt':new Date(), 'data.verificationSource':'PAYSTACK_SIGNED_WEBHOOK' } },
   { new:true }
  );
  // A concurrent verify endpoint may have won; the conditional update makes replay safe.
  return res.status(200).json({ received:true, verified:Boolean(updated), idempotentReplay:!updated });
 } catch (error) { next(error); }
});

// Fee schedules are proposed by Bursary and activated only after Registrar approval.
router.post('/fee-schedules', authenticate, allowRoles('BURSARY'), async (req,res,next) => {
 try {
  const b=z.object({code:z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,40}$/),name:z.string().trim().min(3).max(120),amountNaira:z.number().finite().positive().max(10000000),currency:z.literal('NGN'),session:z.string().trim().min(4).max(30),description:z.string().trim().max(500).optional()}).parse(req.body);
  const existing=await RecordModel.findOne({module:'fee-schedules',reference:`${b.session}:${b.code}`});
  if(existing && ['PROPOSED','APPROVED'].includes(existing.status)) return res.status(409).json({message:'A fee schedule with this code and session already exists.'});
  const schedule=await RecordModel.create({module:'fee-schedules',title:b.name,status:'PROPOSED',reference:`${b.session}:${b.code}`,ownerId:req.user!.id,createdBy:req.user!.id,data:{...b,proposedBy:req.user!.id,proposedAt:new Date()}});
  await audit(req,'FEE_SCHEDULE_PROPOSED','FeeSchedule',String(schedule._id),{code:b.code,session:b.session,amountNaira:b.amountNaira});
  res.status(201).json({schedule,message:'Fee schedule submitted for Registrar approval.'});
 } catch(e) { next(e); }
});
router.get('/fee-schedules', authenticate, allowRoles('BURSARY','REGISTRAR'), async (req,res,next)=>{try{const schedules=await RecordModel.find({module:'fee-schedules'}).sort({createdAt:-1}).limit(300);res.json({schedules});}catch(e){next(e);}});
router.post('/fee-schedules/:id/approve', authenticate, allowRoles('REGISTRAR'), async (req,res,next)=>{
 try {const b=z.object({decision:z.enum(['APPROVE','REJECT']),reason:z.string().trim().min(8).max(500)}).parse(req.body);const schedule=await RecordModel.findOne({_id:req.params.id,module:'fee-schedules',status:'PROPOSED'});if(!schedule)return res.status(404).json({message:'Proposed fee schedule not found.'});const updated=await RecordModel.findOneAndUpdate({_id:schedule._id,module:'fee-schedules',status:'PROPOSED'},{$set:{status:b.decision==='APPROVE'?'APPROVED':'REJECTED',updatedBy:req.user!.id,'data.decisionReason':b.reason,'data.decidedBy':req.user!.id,'data.decidedAt':new Date()}},{new:true});if(!updated)return res.status(409).json({message:'The fee schedule changed. Refresh and review it again.'});await audit(req,b.decision==='APPROVE'?'FEE_SCHEDULE_APPROVED':'FEE_SCHEDULE_REJECTED','FeeSchedule',String(updated._id),{reason:b.reason});res.json({schedule:updated});}catch(e){next(e);}
});

router.post('/initialize', authenticate, async (req,res,next) => {
 try {
  // The client supplies a fee code and session, never an amount. Only Registrar-approved schedules can be charged.
  const b = z.object({ feeCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,40}$/), session: z.string().trim().min(4).max(30) }).parse(req.body);
  const schedule=await RecordModel.findOne({module:'fee-schedules',reference:`${b.session}:${b.feeCode}`,status:'APPROVED','data.currency':'NGN'});
  if(!schedule)return res.status(409).json({message:'No approved fee schedule exists for this fee and session. Contact the Bursary.'});
  const amountNaira=Number((schedule.data as any).amountNaira);
  if(!Number.isFinite(amountNaira)||amountNaira<=0)return res.status(409).json({message:'The approved fee schedule has an invalid amount. Contact the Bursary.'});
  const reference = `UMS-${randomUUID()}`;
  const data = await initializePaystackPayment(req.user!.email, Math.round(amountNaira * 100), reference, { userId:req.user!.id, purpose:schedule.title, feeCode:b.feeCode, session:b.session });
  await RecordModel.create({ module:'finance', title:schedule.title, status:'PAYMENT_INITIALIZED', reference, ownerId:req.user!.id, createdBy:req.user!.id, data:{ amountNaira, currency:'NGN', feeCode:b.feeCode, session:b.session, feeScheduleId:String(schedule._id), feeScheduleReference:schedule.reference, provider:'PAYSTACK' } });
  await audit(req,'PAYMENT_INITIALIZED','Payment',reference,{amountNaira,feeCode:b.feeCode,session:b.session,feeScheduleId:String(schedule._id)});
  res.json({ payment:data, reference, amountNaira, currency:'NGN' });
 } catch(e) { next(e); }
});

// Finance exceptions are review cases, not a way to manually mark a payment as paid.
router.get('/exceptions', authenticate, allowRoles('BURSARY','REGISTRAR'), async (req,res,next)=>{try{const exceptions=await RecordModel.find({module:'finance-exceptions'}).sort({createdAt:-1}).limit(300);res.json({exceptions});}catch(e){next(e);}});
router.post('/exceptions/:id/resolve', authenticate, allowRoles('BURSARY'), async (req,res,next)=>{
 try {const b=z.object({resolution:z.enum(['CONFIRMED_PROVIDER_RECORD','DUPLICATE','REFUND_REQUIRED','ESCALATED']),reason:z.string().trim().min(10).max(1000)}).parse(req.body);const item=await RecordModel.findOne({_id:req.params.id,module:'finance-exceptions',status:'OPEN'});if(!item)return res.status(404).json({message:'Open finance exception not found.'});const updated=await RecordModel.findOneAndUpdate({_id:item._id,module:'finance-exceptions',status:'OPEN'},{$set:{status:'RESOLVED',updatedBy:req.user!.id,'data.resolution':b.resolution,'data.resolutionReason':b.reason,'data.resolvedBy':req.user!.id,'data.resolvedAt':new Date()}},{new:true});if(!updated)return res.status(409).json({message:'This exception was changed by another staff member. Refresh and review it again.'});await audit(req,'FINANCE_EXCEPTION_RESOLVED','FinanceException',String(updated._id),{resolution:b.resolution,reason:b.reason});res.json({exception:updated,message:'Exception review recorded. This action does not mark a payment as paid or issue a refund.'});}catch(e){next(e);}
});
router.post('/verify/:reference', authenticate, async (req,res,next) => {
 try {
  const reference = String(req.params.reference || '').trim();
  if (!reference || reference.length > 120) return res.status(400).json({message:'Invalid payment reference.'});
  // Confirm ownership and expected amount before asking Paystack; never let a caller verify another user's reference.
  const record = await RecordModel.findOne({ module:'finance', reference, ownerId:req.user!.id });
  if (!record) return res.status(404).json({message:'Payment record not found for this account.'});
  if (record.status === 'PAYMENT_VERIFIED' || record.status === 'PAID') return res.json({message:'Payment has already been verified.', payment:record, idempotentReplay:true});
  if (record.status !== 'PAYMENT_INITIALIZED') return res.status(409).json({message:'This payment is not in a verifiable pending state.'});
  const expectedKobo = Math.round(Number((record.data as any).amountNaira) * 100);
  if (!Number.isFinite(expectedKobo) || expectedKobo < 1) return res.status(409).json({message:'This payment record has no valid expected amount.'});
  const data = await verifyPaystackPayment(reference);
  if (data.reference !== reference || data.status !== 'success' || data.currency !== 'NGN' || data.amount !== expectedKobo) {
   const existingException=await RecordModel.findOne({module:'finance-exceptions',reference:`PAYMENT:${reference}`,status:'OPEN'});
   if(!existingException) await RecordModel.create({module:'finance-exceptions',title:`Payment verification mismatch: ${reference}`,status:'OPEN',reference:`PAYMENT:${reference}`,ownerId:record.ownerId,createdBy:req.user!.id,data:{paymentRecordId:String(record._id),paymentReference:reference,expectedKobo,actualKobo:data.amount,actualCurrency:data.currency,providerStatus:data.status,detectedAt:new Date(),exceptionType:'PAYMENT_VERIFICATION_MISMATCH'}});
   await audit(req,'PAYMENT_VERIFICATION_MISMATCH','Payment',reference,{expectedKobo,actualKobo:data.amount,currency:data.currency,status:data.status});
   return res.status(409).json({message:'Paystack payment details do not match the expected reference, amount and NGN currency. The payment was not marked verified; a finance exception was opened for review.'});
  }
  const updated = await RecordModel.findOneAndUpdate(
   {_id:record._id, ownerId:req.user!.id, status:'PAYMENT_INITIALIZED', reference, 'data.amountNaira':(record.data as any).amountNaira},
   {$set:{status:(record.data as any).applicationFee ? 'PAYMENT_VERIFIED' : 'PAID', 'data.verifiedAmountKobo':data.amount, 'data.currency':data.currency, 'data.verifiedAt':new Date(), 'data.verificationSource':'PAYSTACK_SERVER_API'}},
   {new:true}
  );
  const current = updated || await RecordModel.findOne({_id:record._id,ownerId:req.user!.id});
  if (!current || !['PAYMENT_VERIFIED','PAID'].includes(current.status)) return res.status(409).json({message:'Payment verification is being reconciled. Refresh the payment status before continuing.'});
  if (updated) await audit(req,'PAYMENT_VERIFIED','Payment',reference,{status:data.status,amountKobo:data.amount,currency:data.currency});
  res.json({message:'Payment verified with Paystack.', payment:current, idempotentReplay:!updated});
 } catch(e) { next(e); }
});
export default router;

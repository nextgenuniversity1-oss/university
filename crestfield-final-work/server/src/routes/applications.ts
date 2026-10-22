import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import mongoose from 'mongoose';
import { z } from 'zod';
import { Application } from '../models/Application.js';
import { ScreeningBatch } from '../models/ScreeningBatch.js';
import { ProgrammeCapacity } from '../models/ProgrammeCapacity.js';
import { SystemSetting } from '../models/SystemSetting.js';
import { RecordModel } from '../models/Record.js';
import { User } from '../models/User.js';
import { authenticate, allowRoles } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { notify, queueEmailUserIfEnabled } from '../services/notifications.js';
import { initializePaystackPayment, verifyPaystackPayment } from '../services/paystack.js';
import { env } from '../config/env.js';
import { destroyCloudinaryAsset } from '../services/cloudinaryCleanup.js';

const router = Router();
const DOCUMENT_TYPES = ['passport','birth_certificate','citizenship_certificate','signature','jamb_result','olevel_result'] as const;
type DocumentType = typeof DOCUMENT_TYPES[number];
const REQUIRED_DOCUMENTS: DocumentType[] = [...DOCUMENT_TYPES];
const documentLabels: Record<DocumentType,string> = {
  passport:'Passport photograph', birth_certificate:'Birth certificate (PDF)', citizenship_certificate:'Citizenship certificate (PDF)',
  signature:'Signature image', jamb_result:'JAMB / UTME result', olevel_result:'O’Level result(s)',
};
const upload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 7 },
  fileFilter: (_req,file,cb) => {
    const type = file.fieldname as DocumentType;
    const allowed = type === 'passport' || type === 'signature'
      ? ['image/jpeg','image/png']
      : type === 'birth_certificate' || type === 'citizenship_certificate'
        ? ['application/pdf']
        : ['application/pdf','image/jpeg','image/png'];
    if (!DOCUMENT_TYPES.includes(type) || !allowed.includes(file.mimetype)) return cb(new Error(`Unsupported file type for ${file.fieldname}. Use JPEG/PNG images or PDF documents as appropriate.`));
    cb(null,true);
  },
});
const uploadFields = upload.fields(DOCUMENT_TYPES.map(name => ({ name, maxCount: name === 'olevel_result' ? 2 : 1 })));

async function admissionsConfig() {
  const row = await SystemSetting.findOne({ key: 'admissions' }).lean();
  return (row?.value || {}) as {
    applicationOpen?: boolean; session?: string; applicationDeadline?: string; applicationFeeNaira?: number;
    screeningRulesVersion?: string; requiredDocuments?: string[]; programmeCapacities?: Record<string,number>;
    eligibilityRules?: Record<string,unknown>;
  };
}
function assertOpen(config: Awaited<ReturnType<typeof admissionsConfig>>) {
  if (config.applicationOpen === false) throw Object.assign(new Error('Applications are currently closed.'), { status: 403 });
  if (config.applicationDeadline && new Date(config.applicationDeadline).getTime() < Date.now()) throw Object.assign(new Error('The application deadline has passed.'), { status: 403 });
}
function cloudinaryConfigured() { return Boolean(env.cloudinaryCloudName && env.cloudinaryApiKey && env.cloudinaryApiSecret); }
function configureCloudinary() { cloudinary.config({ cloud_name: env.cloudinaryCloudName, api_key: env.cloudinaryApiKey, api_secret: env.cloudinaryApiSecret, secure: true }); }
function uploadPrivate(buffer: Buffer, file: Express.Multer.File, ownerId: string, appRef: string, documentType: DocumentType) {
  configureCloudinary();
  const resourceType = file.mimetype === 'application/pdf' ? 'raw' : 'image';
  const ext = file.mimetype === 'application/pdf' ? 'pdf' : file.mimetype === 'image/png' ? 'png' : 'jpg';
  return new Promise<any>((resolve,reject) => {
    const stream = cloudinary.uploader.upload_stream({
      folder: `crestfield/private-applications/${ownerId}/${appRef}`, resource_type: resourceType, type: 'authenticated',
      public_id: `${documentType}-${randomUUID()}`, format: ext, overwrite: false, invalidate: false,
      context: { documentType, applicationReference: appRef },
    }, (error,result) => error ? reject(error) : resolve(result));
    stream.end(buffer);
  });
}
function filesFromRequest(req: Express.Request) { return (req.files || {}) as Record<string, Express.Multer.File[]>; }
function docChecklist(documents: Array<{documentType:string}>) {
  return Object.fromEntries(REQUIRED_DOCUMENTS.map(type => [type, documents.some(d => d.documentType === type)]));
}
function requiredDocumentTypes(_config: Awaited<ReturnType<typeof admissionsConfig>>): DocumentType[] {
  // These six documents are a fixed application requirement. Configuration may display them,
  // but cannot silently weaken the agreed application requirements by unchecking a document.
  return [...REQUIRED_DOCUMENTS];
}
function fileSignatureMatches(file: Express.Multer.File): boolean {
  const b = file.buffer;
  if (file.mimetype === 'application/pdf') return b.length >= 5 && b.subarray(0, 5).toString('ascii') === '%PDF-';
  if (file.mimetype === 'image/jpeg') return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (file.mimetype === 'image/png') return b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  return false;
}
function validateUploadedFiles(files: Record<string, Express.Multer.File[]>): string | null {
  for (const [type, items] of Object.entries(files)) {
    const file = items?.[0]; if (!file) continue;
    if (!DOCUMENT_TYPES.includes(type as DocumentType)) return `Unsupported document field: ${type}.`;
    if (!fileSignatureMatches(file)) return `${documentLabels[type as DocumentType]} does not match its declared file type. Upload a genuine JPEG, PNG or PDF file.`;
    if ((type === 'passport' || type === 'signature') && !['image/jpeg','image/png'].includes(file.mimetype)) return `${documentLabels[type as DocumentType]} must be a JPEG or PNG image.`;
    if (['birth_certificate','citizenship_certificate'].includes(type) && file.mimetype !== 'application/pdf') return `${documentLabels[type as DocumentType]} must be a PDF.`;
  }
  return null;
}
function docsComplete(documents: Array<{documentType:string}>, required: DocumentType[] = REQUIRED_DOCUMENTS) { return required.every(type => documents.some(d => d.documentType === type)); }
export async function expireOffers(session?: string) {
  const now = new Date();
  const filter: Record<string, any> = { offers: { $elemMatch: { status: 'ISSUED', acceptanceDeadline: { $lt: now } } } };
  if (session) filter.session = session;
  const apps = await Application.find(filter).limit(250).select('_id session offers');
  for (const candidate of apps) {
    const dbSession = await mongoose.startSession();
    try {
      await dbSession.withTransaction(async () => {
        const app = await Application.findOne({ _id: candidate._id, offers: { $elemMatch: { status: 'ISSUED', acceptanceDeadline: { $lt: now } } } }).session(dbSession);
        if (!app) return;
        let changed = false;
        for (const offer of app.offers as any[]) {
          if (offer.status !== 'ISSUED' || new Date(offer.acceptanceDeadline).getTime() >= now.getTime()) continue;
          offer.status = 'EXPIRED'; changed = true;
          await ProgrammeCapacity.updateOne({ session: app.session, programme: offer.programme, reserved: { $gt: 0 } }, { $inc: { reserved: -1 } }, { session: dbSession });
        }
        if (changed) {
          const stillIssued = (app.offers as any[]).some(o => o.status === 'ISSUED');
          if (!stillIssued && app.status !== 'ACCEPTED') app.status = (app.offers as any[]).some(o => o.status === 'ACCEPTED') ? 'ACCEPTED' : 'DECISION_PENDING';
          await app.save({ session: dbSession });
        }
      });
    } finally { await dbSession.endSession(); }
  }
}

async function applicationEvent(userId: string, event: 'assigned'|'clarification'|'ready'|'decision', message: string, title: string) {
  // Notification delivery must not make a committed admissions action appear to have failed.
  await notify(userId,title,message).catch(error => console.error('Admission in-app notification failed:', error));
  const emailTitles: Record<typeof event,string> = {
    assigned: 'New Admission Application Assigned',
    clarification: 'Application Requires Additional Information',
    ready: 'Application Ready for Review',
    decision: 'Admission Decision Pending',
  };
  // These are the four agreed admission email events. Other status changes remain in-app only.
  await queueEmailUserIfEnabled(userId, `admission:${userId}:${event}:${message.match(/CF\/[^ ]+/)?.[0] || 'event'}`, emailTitles[event], message).catch(error => console.error('Admission email queue failed:', error));
}
function safeApplication(app: any, _isApplicant: boolean) {
  const json = app.toObject ? app.toObject() : { ...app };
  // Never expose authenticated Cloudinary public IDs or resource metadata in list/detail payloads.
  json.documents = (json.documents || []).map((d: any) => ({ documentType:d.documentType, originalName:d.originalName, mimeType:d.mimeType, bytes:d.bytes, uploadedAt:d.uploadedAt }));
  return json;
}

router.use(authenticate, async (req,res,next) => {
  try {
    if (req.user?.role === 'SUPER_ADMIN') return next();
    const row = await SystemSetting.findOne({ key: 'general' }).lean();
    const settings = (row?.value || {}) as { maintenanceMode?: boolean };
    if (settings.maintenanceMode) return res.status(503).json({ message: 'The university portal is temporarily under maintenance. Please try again later.' });
    next();
  } catch (error) { next(error); }
});

router.get('/config', allowRoles('APPLICANT','ADMISSION_OFFICER','REGISTRAR'), async (_req,res,next) => {
  try {
    const c = await admissionsConfig();
    res.json({ applicationOpen: c.applicationOpen !== false, session: c.session || '', applicationDeadline: c.applicationDeadline || null,
      applicationFeeNaira: typeof c.applicationFeeNaira === 'number' ? c.applicationFeeNaira : null,
      requiredDocuments: REQUIRED_DOCUMENTS.map(type => ({ type, label: documentLabels[type] })),
      screeningRulesVersion: c.screeningRulesVersion || 'not-configured', eligibilityRules: c.eligibilityRules || {},
      programmeCapacitiesConfigured: Boolean(c.programmeCapacities && Object.keys(c.programmeCapacities).length),
      cloudinaryConfigured: cloudinaryConfigured(), paystackConfigured: Boolean(env.paystackSecretKey) });
  } catch(e) { next(e); }
});

router.get('/overview', allowRoles('ADMISSION_OFFICER','REGISTRAR'), async (_req,res,next) => {
  try {
    await expireOffers();
    const [total,pending,needsInfo,ready,decisionPending,offered,eligible,unprocessed] = await Promise.all([
      Application.countDocuments({}), Application.countDocuments({status:{$in:['SUBMITTED','UNDER_REVIEW']}}),
      Application.countDocuments({status:'NEEDS_INFORMATION'}), Application.countDocuments({status:'READY_FOR_REVIEW'}),
      Application.countDocuments({status:'DECISION_PENDING'}), Application.countDocuments({status:{$in:['OFFERED','ALTERNATIVE_OFFERED','ACCEPTED']}}),
      Application.countDocuments({eligibility:'ELIGIBLE',paymentStatus:'VERIFIED'}),
      Application.countDocuments({eligibility:'ELIGIBLE',paymentStatus:'VERIFIED',screeningBatchId:{$in:[null]}}),
    ]);
    res.json({stats:{total,pending,needsInfo,ready,decisionPending,offered,eligible,unprocessed}});
  } catch(e) { next(e); }
});

router.get('/', async (req,res,next) => {
  try {
    const isApplicant = req.user!.role === 'APPLICANT';
    if (!isApplicant && !['ADMISSION_OFFICER','REGISTRAR'].includes(req.user!.role)) return res.status(403).json({message:'You do not have permission to view applications.'});
    const page = Math.max(1,Number(req.query.page)||1), limit = Math.min(100,Math.max(1,Number(req.query.limit)||25));
    const q = String(req.query.q||'').trim().slice(0,100); const status = String(req.query.status||''); const session = String(req.query.session||'');
    const eligibility = String(req.query.eligibility||''); const paymentStatus = String(req.query.paymentStatus||'');
    const assignedToMe = String(req.query.assignedToMe||'') === 'true';
    const filter: Record<string,any> = isApplicant ? { applicantId:req.user!.id } : {};
    if (status) filter.status = status;
    if (session) filter.session = session;
    if (eligibility && ['UNASSESSED','ELIGIBLE','INELIGIBLE','NEEDS_REVIEW'].includes(eligibility)) filter.eligibility = eligibility;
    if (paymentStatus && ['UNPAID','VERIFIED'].includes(paymentStatus)) filter.paymentStatus = paymentStatus;
    if (assignedToMe && req.user!.role === 'ADMISSION_OFFICER') filter.assignedOfficerId = req.user!.id;
    if (q && !isApplicant) { const escaped=q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); filter.$or = [{applicationNumber:{$regex:escaped,$options:'i'}},{fullName:{$regex:escaped,$options:'i'}},{email:{$regex:escaped,$options:'i'}},{utmeNumber:{$regex:escaped,$options:'i'}},{firstChoiceCourse:{$regex:escaped,$options:'i'}}]; }
    const [apps,total] = await Promise.all([Application.find(filter).sort({createdAt:-1}).skip((page-1)*limit).limit(limit),Application.countDocuments(filter)]);
    res.json({applications:apps.map(a=>safeApplication(a,isApplicant)),total,page,limit,pages:Math.max(1,Math.ceil(total/limit)),statuses:['SUBMITTED','UNDER_REVIEW','NEEDS_INFORMATION','READY_FOR_REVIEW','SCREENING_QUEUED','SCREENING_IN_PROGRESS','DECISION_PENDING','OFFERED','ALTERNATIVE_OFFERED','ACCEPTED','DECLINED','REJECTED','INELIGIBLE','UNSUCCESSFUL']});
  } catch(e) { next(e); }
});

router.post('/fee/initialize', allowRoles('APPLICANT'), async (req,res,next) => {
  try {
    const b = z.object({session:z.string().trim().min(4).max(30)}).parse(req.body);
    const c = await admissionsConfig(); assertOpen(c);
    if (!c.session || b.session !== c.session) return res.status(400).json({message:'Choose the currently configured admission session.'});
    if (typeof c.applicationFeeNaira !== 'number' || !Number.isFinite(c.applicationFeeNaira) || c.applicationFeeNaira < 0) return res.status(503).json({message:'The application fee has not been configured by the university.'});
    if (c.applicationFeeNaira === 0) {
      const reference = `CF-APP-FREE-${randomUUID()}`;
      await RecordModel.create({module:'finance',title:'UTME application fee (configured as free)',status:'PAYMENT_VERIFIED',reference,ownerId:req.user!.id,createdBy:req.user!.id,data:{applicationFee:true,session:b.session,amountNaira:0,verifiedAt:new Date(),purpose:'application-fee'}});
      await audit(req,'APPLICATION_FEE_WAIVED_BY_CONFIGURATION','ApplicationFee',reference,{session:b.session,amountNaira:0});
      return res.json({reference,free:true,message:'The university has configured this application session with no application fee.'});
    }
    const reference = `CF-APP-${randomUUID()}`;
    const payment = await initializePaystackPayment(req.user!.email,Math.round(c.applicationFeeNaira*100),reference,{userId:req.user!.id,purpose:'application-fee',session:b.session});
    await RecordModel.create({module:'finance',title:'UTME application fee',status:'PAYMENT_INITIALIZED',reference,ownerId:req.user!.id,createdBy:req.user!.id,data:{applicationFee:true,session:b.session,amountNaira:c.applicationFeeNaira,purpose:'application-fee',provider:'PAYSTACK'}});
    await audit(req,'APPLICATION_FEE_INITIALIZED','ApplicationFee',reference,{session:b.session,amountNaira:c.applicationFeeNaira});
    res.json({reference,payment,free:false});
  } catch(e) { next(e); }
});

router.post('/fee/verify/:reference', allowRoles('APPLICANT'), async (req,res,next) => {
  try {
    const record = await RecordModel.findOne({module:'finance',reference:req.params.reference,ownerId:req.user!.id,'data.applicationFee':true});
    if (!record) return res.status(404).json({message:'Application fee payment reference not found for this account.'});
    if (record.status === 'PAYMENT_VERIFIED') return res.json({verified:true,reference:record.reference,session:(record.data as any).session,message:'Application fee is already verified.'});
    const expectedKobo = Math.round(Number((record.data as any).amountNaira)*100);
    const result = await verifyPaystackPayment(req.params.reference);
    if (result.reference !== req.params.reference || result.status !== 'success' || result.currency !== 'NGN' || result.amount !== expectedKobo) return res.status(409).json({message:'The verified payment does not match the expected application fee. Contact the Bursary.'});
    // Dot-path updates preserve a concurrently claimed application reference; replacing the whole Mixed data object could undo that claim.
    const verifiedAt = new Date();
    const updated = await RecordModel.findOneAndUpdate(
      {_id:record._id,ownerId:req.user!.id,status:'PAYMENT_INITIALIZED','data.applicationFee':true,'data.session':(record.data as any).session,'data.amountNaira':(record.data as any).amountNaira},
      {$set:{status:'PAYMENT_VERIFIED','data.verifiedAmountKobo':result.amount,'data.currency':result.currency,'data.verifiedAt':verifiedAt,'data.verificationSource':'PAYSTACK_SERVER_API'}},
      {new:true},
    );
    const current = updated || await RecordModel.findOne({_id:record._id,ownerId:req.user!.id});
    if (!current || current.status !== 'PAYMENT_VERIFIED') return res.status(409).json({message:'Payment verification is still being reconciled. Refresh the payment status before submitting.'});
    if (updated) {
      await audit(req,'APPLICATION_FEE_VERIFIED','ApplicationFee',record.reference ?? undefined,{session:(current.data as any).session,amountKobo:result.amount,currency:result.currency});
      await notify(req.user!.id,'Application fee confirmed','Your application fee has been verified. Complete and submit your UTME application with all required documents.').catch(error=>console.error('Application fee notification failed:',error));
    }
    res.json({verified:true,reference:current.reference,session:(current.data as any).session,message:'Application fee verified by Paystack.'});
  } catch(e) { next(e); }
});

router.post('/', allowRoles('APPLICANT'), (req,res,next) => uploadFields(req,res,err => err ? res.status(400).json({message:err.message||'Invalid uploaded file.'}) : next()), async (req,res,next) => {
  const uploaded: any[] = []; let paymentRecord:any=null; let claimedApplicationId:string|null=null; let applicationPersisted=false;
  try {
    const c = await admissionsConfig(); assertOpen(c);
    if (!cloudinaryConfigured()) return res.status(503).json({message:'Secure document storage is not configured. Contact the university; do not email sensitive documents.'});
    const body = z.object({fullName:z.string().trim().min(2).max(160),email:z.string().email(),phone:z.string().trim().min(6).max(30),utmeNumber:z.string().trim().min(5).max(40),utmeScore:z.coerce.number().int().min(0).max(400),firstChoiceCourse:z.string().trim().min(2).max(160),faculty:z.string().trim().min(2).max(160),session:z.string().trim().min(4).max(30),paymentReference:z.string().trim().min(8).max(100)}).parse(req.body);
    const account = await User.findById(req.user!.id).select('email');
    if (!account || body.email.trim().toLowerCase() !== account.email.trim().toLowerCase()) return res.status(400).json({message:'The application email must match the email address on your signed-in applicant account. Update your account email through the approved account process before applying if it is incorrect.'});
    if (!c.session || body.session !== c.session) return res.status(400).json({message:'This is not the currently configured admission session.'});
    const files = filesFromRequest(req);
    const invalidFile = validateUploadedFiles(files); if (invalidFile) return res.status(400).json({message:invalidFile});
    const requiredTypes = requiredDocumentTypes(c);
    const missing = requiredTypes.filter(type => !(files[type]?.[0]));
    if (missing.length) return res.status(400).json({message:`Upload all required documents before submission: ${missing.map(x=>documentLabels[x]).join(', ')}.`});
    const payment = await RecordModel.findOne({module:'finance',reference:body.paymentReference,ownerId:req.user!.id,status:'PAYMENT_VERIFIED','data.applicationFee':true,'data.session':body.session});
    if (!payment) return res.status(402).json({message:'A verified application fee for this session is required before submission.'});
    if (typeof c.applicationFeeNaira !== 'number' || Number((payment.data as any).amountNaira) !== c.applicationFeeNaira) return res.status(409).json({message:'The configured application fee changed after this payment was initialized. Contact the Bursary before submitting.'});
    if ((payment.data as any).usedForApplicationId) return res.status(409).json({message:'This verified fee has already been used for an application.'});
    if (await Application.exists({applicantId:req.user!.id,session:body.session})) return res.status(409).json({message:'You already have an application for this session. The university permits one application per applicant per session.'});
    if (await Application.exists({paymentReference:body.paymentReference})) return res.status(409).json({message:'This payment reference has already been used for an application.'});
    const appNumber = `CF/${body.session.replace(/[^A-Za-z0-9]/g,'')}/${randomUUID().slice(0,8).toUpperCase()}`;
    const applicationId = new mongoose.Types.ObjectId();
    const documents: any[] = [];
    for (const type of requiredTypes) {
      const selectedFiles = files[type] || [];
      for (const file of selectedFiles) {
        const result = await uploadPrivate(file.buffer,file,req.user!.id,appNumber.replaceAll('/','-'),type);
        uploaded.push({publicId:result.public_id,resourceType:result.resource_type});
        documents.push({documentType:type,publicId:result.public_id,resourceType:result.resource_type,format:result.format || (file.mimetype==='application/pdf'?'pdf':file.mimetype==='image/png'?'png':'jpg'),originalName:file.originalname,mimeType:file.mimetype,bytes:file.size,uploadedAt:new Date()});
      }
    }
    // Atomically claim this verified payment so two simultaneous submissions cannot spend it twice.
    const claimedPayment = await RecordModel.findOneAndUpdate(
      { _id:payment._id, status:'PAYMENT_VERIFIED', 'data.applicationFee':true, 'data.session':body.session, 'data.amountNaira':c.applicationFeeNaira, 'data.usedForApplicationId':{ $exists:false } },
      { $set:{ 'data.usedForApplicationId':String(applicationId), 'data.usedAt':new Date() } },
      { new:true }
    );
    if (!claimedPayment) {
      if (uploaded.length && cloudinaryConfigured()) await Promise.all(uploaded.map(x=>destroyCloudinaryAsset({publicId:x.publicId,resourceType:x.resourceType,deliveryType:'authenticated'})));
      return res.status(409).json({message:'This verified fee has already been claimed by another submission. Refresh your application list before trying again.'});
    }
    paymentRecord = claimedPayment; claimedApplicationId=String(applicationId);
    const application = await Application.create({_id:applicationId,applicationNumber:appNumber,applicantId:req.user!.id,...body,email:body.email.toLowerCase(),paymentReference:body.paymentReference,applicationFeeNaira:Number((claimedPayment.data as any).amountNaira),paymentStatus:'VERIFIED',status:'SUBMITTED',documents,documentChecklist:docChecklist(documents),submittedAt:new Date(),eligibility:'UNASSESSED'});
    applicationPersisted=true;
    await audit(req,'APPLICATION_SUBMITTED','Application',application.id,{applicationNumber:appNumber,session:body.session,applicationType:'UTME',documentCount:documents.length,paymentReference:body.paymentReference});
    await notify(req.user!.id,'Application submitted',`Your UTME application ${appNumber} has been submitted. Application submission, fee verification and admission decisions are separate stages.`).catch(error=>console.error('Application notification could not be stored',error));
    res.status(201).json({application:safeApplication(application,true),message:'Your application has been submitted successfully.'});
  } catch(e: any) {
    if (!applicationPersisted && paymentRecord && claimedApplicationId) {
      await RecordModel.updateOne({ _id:paymentRecord._id, 'data.usedForApplicationId':claimedApplicationId }, { $unset:{ 'data.usedForApplicationId':'', 'data.usedAt':'' } }).catch(()=>undefined);
    }
    if (!applicationPersisted && uploaded.length && cloudinaryConfigured()) {
      await Promise.all(uploaded.map(x=>destroyCloudinaryAsset({publicId:x.publicId,resourceType:x.resourceType,deliveryType:'authenticated'})));
    }
    if (e?.code === 11000) return res.status(409).json({message:'An application already exists for this session, or this payment reference has already been used.'});
    next(e);
  }
});

router.patch('/:id', allowRoles('APPLICANT'), (req,res,next) => uploadFields(req,res,err => err ? res.status(400).json({message:err.message||'Invalid uploaded file.'}) : next()), async (req,res,next) => {
  const uploaded: any[] = []; const obsolete: any[] = [];
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({message:'Invalid application identifier.'});
    const app = await Application.findOne({_id:req.params.id,applicantId:req.user!.id});
    if (!app) return res.status(404).json({message:'Application not found.'});
    const c = await admissionsConfig();
    if (c.applicationDeadline) { const deadline = new Date(c.applicationDeadline).getTime(); if (!Number.isFinite(deadline) || deadline < Date.now()) return res.status(403).json({message:'The application correction deadline has passed or is invalid. Contact the Admissions Office.'}); }
    if (app.screeningBatchId || app.screeningProcessedAt || !['SUBMITTED','NEEDS_INFORMATION'].includes(app.status)) return res.status(409).json({message:'This application is locked because screening has started or the workflow has advanced beyond the correction stage.'});
    const body = z.object({fullName:z.string().trim().min(2).max(160).optional(),email:z.string().email().optional(),phone:z.string().trim().min(6).max(30).optional(),utmeNumber:z.string().trim().min(5).max(40).optional(),utmeScore:z.coerce.number().int().min(0).max(400).optional(),firstChoiceCourse:z.string().trim().min(2).max(160).optional(),faculty:z.string().trim().min(2).max(160).optional()}).parse(req.body);
    if (body.email) { const account=await User.findById(req.user!.id).select('email'); if(!account || body.email.trim().toLowerCase()!==account.email.trim().toLowerCase()) return res.status(400).json({message:'The application email must match your signed-in applicant account email.'}); }
    const files = filesFromRequest(req);
    const invalidFile = validateUploadedFiles(files); if (invalidFile) return res.status(400).json({message:invalidFile});
    if (Object.keys(files).length && !cloudinaryConfigured()) return res.status(503).json({message:'Secure document storage is not configured.'});
    for (const type of REQUIRED_DOCUMENTS) if (files[type]?.length) {
      const replacements:any[] = [];
      for (const f of files[type]) {
        const result = await uploadPrivate(f.buffer,f,req.user!.id,app.applicationNumber.replaceAll('/','-'),type);
        uploaded.push({publicId:result.public_id,resourceType:result.resource_type});
        replacements.push({documentType:type,publicId:result.public_id,resourceType:result.resource_type,format:result.format || (f.mimetype==='application/pdf'?'pdf':f.mimetype==='image/png'?'png':'jpg'),originalName:f.originalname,mimeType:f.mimetype,bytes:f.size,uploadedAt:new Date()});
      }
      for (const existing of (app.documents as any[]).filter(d=>d.documentType===type)) obsolete.push({publicId:existing.publicId,resourceType:existing.resourceType});
      const rest = (app.documents as any[]).filter(d=>d.documentType!==type).map(d=>d.toObject ? d.toObject() : d);
      app.documents = [...rest,...replacements] as any;
    }
    Object.assign(app,body); if (body.email) app.email = body.email.toLowerCase(); app.documentChecklist = docChecklist(app.documents as any); app.lastEditedAt = new Date(); if (app.status==='NEEDS_INFORMATION') { app.status='SUBMITTED'; app.clarificationRequest=undefined; }
    await app.save();
    if (obsolete.length && cloudinaryConfigured()) await Promise.all(obsolete.map(x=>destroyCloudinaryAsset({publicId:x.publicId,resourceType:x.resourceType,deliveryType:'authenticated'})));
    await audit(req,'APPLICATION_CORRECTED','Application',app.id,{fields:Object.keys(body),replacedDocuments:Object.keys(files)});
    res.json({application:safeApplication(app,true),message:'Application corrections saved.'});
  } catch(e: any) {
    if (uploaded.length && cloudinaryConfigured()) await Promise.all(uploaded.map(x=>destroyCloudinaryAsset({publicId:x.publicId,resourceType:x.resourceType,deliveryType:'authenticated'})));
    if (e?.code === 11000) return res.status(409).json({message:'The application update conflicts with an existing record.'}); next(e);
  }
});

router.get('/:id/documents/:type', allowRoles('APPLICANT','ADMISSION_OFFICER','REGISTRAR'), async (req,res,next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id) || !DOCUMENT_TYPES.includes(req.params.type as DocumentType)) return res.status(400).json({message:'Invalid application or document identifier.'});
    const app = await Application.findById(req.params.id);
    if (!app) return res.status(404).json({message:'Application not found.'});
    if (req.user!.role === 'APPLICANT' && String(app.applicantId)!==req.user!.id) return res.status(403).json({message:'You cannot access another applicant’s documents.'});
    if (req.user!.role === 'ADMISSION_OFFICER' && app.assignedOfficerId && String(app.assignedOfficerId)!==req.user!.id) return res.status(403).json({message:'This application is assigned to another Admission Officer. Ask the authorized office to reassign it before accessing documents.'});
    const matchingDocs = (app.documents as any[]).filter(d=>d.documentType===req.params.type);
    if (!matchingDocs.length) return res.status(404).json({message:'Document not uploaded.'});
    const requestedIndex=Number(req.query.index??0);
    if(!Number.isInteger(requestedIndex)||requestedIndex<0||requestedIndex>=matchingDocs.length) return res.status(400).json({message:`Document index must be between 0 and ${matchingDocs.length-1}.`});
    const doc=matchingDocs[requestedIndex];
    if (!cloudinaryConfigured()) return res.status(503).json({message:'Secure document provider is not configured.'});
    configureCloudinary();
    const url = cloudinary.utils.private_download_url(doc.publicId,doc.format,{resource_type:doc.resourceType,type:'authenticated',expires_at:Math.floor(Date.now()/1000)+300} as any);
    await audit(req,'APPLICATION_DOCUMENT_ACCESSED','ApplicationDocument',app.id,{documentType:doc.documentType,index:requestedIndex});
    res.json({url,expiresInSeconds:300,documentType:doc.documentType,index:requestedIndex,total:matchingDocs.length});
  } catch(e) { next(e); }
});

router.post('/:id/assign', allowRoles('ADMISSION_OFFICER'), async (req,res,next) => {
  try {
    const b = z.object({officerId:z.string().min(1)}).parse(req.body);
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({message:'Invalid application identifier.'});
    if (b.officerId !== req.user!.id) return res.status(403).json({message:'Admission Officers may claim unassigned applications for themselves. Assignment to another officer requires an authorized administrative workflow.'});
    const app = await Application.findById(req.params.id); if (!app) return res.status(404).json({message:'Application not found.'});
    if (app.screeningBatchId || ['ACCEPTED','DECLINED','REJECTED','INELIGIBLE','UNSUCCESSFUL'].includes(app.status)) return res.status(409).json({message:'This application can no longer be assigned because screening has started or the application has a terminal outcome.'});
    if (app.assignedOfficerId && String(app.assignedOfficerId)!==req.user!.id) return res.status(409).json({message:'This application is already assigned to another Admission Officer. Reassignment must be performed through an authorized administrative workflow.'});
    const officer = await User.findOne({_id:b.officerId,role:'ADMISSION_OFFICER',status:'ACTIVE'}).select('fullName email');
    if (!officer) return res.status(400).json({message:'Choose an active Admission Officer account.'});
    const claimed = await Application.findOneAndUpdate(
      {_id:app._id, assignedOfficerId: {$in:[null, req.user!.id]}, screeningBatchId:{$in:[null]}, status:{$nin:['ACCEPTED','DECLINED','REJECTED','INELIGIBLE','UNSUCCESSFUL']}},
      {$set:{assignedOfficerId:officer._id,assignedOfficerEmail:officer.email}}, {new:true}
    );
    if (!claimed) return res.status(409).json({message:'Another officer or workflow changed this application while you were claiming it. Refresh and try again.'});
    const assignedApp = claimed;
    await applicationEvent(String(officer._id),'assigned',`Application ${assignedApp.applicationNumber} has been assigned to you for admission processing.`,'New Admission Application Assigned');
    await audit(req,'APPLICATION_ASSIGNED','Application',assignedApp.id,{officerId:String(officer._id),officerEmail:officer.email});
    res.json({application:assignedApp,message:'Application assigned to Admission Officer.'});
  } catch(e) { next(e); }
});

router.patch('/:id/review', allowRoles('ADMISSION_OFFICER'), async (req,res,next) => {
  try {
    const b = z.object({note:z.string().trim().min(5).max(2000).optional()}).parse(req.body);
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({message:'Invalid application identifier.'});
    const app = await Application.findById(req.params.id); if (!app) return res.status(404).json({message:'Application not found.'});
    if (app.assignedOfficerId && String(app.assignedOfficerId)!==req.user!.id) return res.status(403).json({message:'This application is assigned to another Admission Officer.'});
    if (!['SUBMITTED','UNDER_REVIEW','NEEDS_INFORMATION','READY_FOR_REVIEW'].includes(app.status)) return res.status(409).json({message:'This application cannot enter document review from its current status.'});
    app.status = 'UNDER_REVIEW'; if (b.note) app.reviewNote = b.note; await app.save();
    await audit(req,'APPLICATION_REVIEW_STARTED','Application',app.id,{note:b.note}); res.json({application:app});
  } catch(e) { next(e); }
});

router.post('/:id/clarification', allowRoles('ADMISSION_OFFICER'), async (req,res,next) => {
  try {
    const b = z.object({message:z.string().trim().min(10).max(2000)}).parse(req.body);
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({message:'Invalid application identifier.'});
    const app = await Application.findById(req.params.id); if (!app) return res.status(404).json({message:'Application not found.'});
    if (app.assignedOfficerId && String(app.assignedOfficerId)!==req.user!.id) return res.status(403).json({message:'This application is assigned to another Admission Officer.'});
    if (app.screeningBatchId || !['SUBMITTED','UNDER_REVIEW','NEEDS_INFORMATION','READY_FOR_REVIEW'].includes(app.status)) return res.status(409).json({message:'A clarification request is only available during pre-screening review. This application has advanced beyond that stage.'});
    app.status = 'NEEDS_INFORMATION'; app.clarificationRequest = b.message; app.reviewNote = b.message; await app.save();
    await applicationEvent(String(app.applicantId),'clarification',`Action required for application ${app.applicationNumber}: ${b.message}`,'Application Requires Additional Information');
    await audit(req,'APPLICATION_CLARIFICATION_REQUESTED','Application',app.id,{message:b.message}); res.json({application:app,message:'Clarification request sent.'});
  } catch(e) { next(e); }
});

router.patch('/:id/eligibility', allowRoles('ADMISSION_OFFICER'), async (req,res,next) => {
  try {
    const b = z.object({eligibility:z.enum(['ELIGIBLE','INELIGIBLE','NEEDS_REVIEW']),reason:z.string().trim().min(5).max(2000)}).parse(req.body);
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({message:'Invalid application identifier.'});
    const app = await Application.findById(req.params.id); if (!app) return res.status(404).json({message:'Application not found.'});
    if (app.assignedOfficerId && String(app.assignedOfficerId)!==req.user!.id) return res.status(403).json({message:'This application is assigned to another Admission Officer.'});
    if (app.screeningBatchId || ['ACCEPTED','DECLINED','REJECTED','INELIGIBLE','UNSUCCESSFUL'].includes(app.status)) return res.status(409).json({message:'Eligibility is locked after screening starts or a terminal outcome is recorded. Use the authorized correction or appeal process.'});
    const c = await admissionsConfig();
    if (b.eligibility==='ELIGIBLE' && (app.paymentStatus!=='VERIFIED' || !docsComplete(app.documents as any,requiredDocumentTypes(c)))) return res.status(409).json({message:'Eligibility cannot be marked ELIGIBLE until the application fee is verified and every configured required document is present.'});
    app.eligibility = b.eligibility; app.eligibilityReason = b.reason;
    if (b.eligibility==='INELIGIBLE') app.status='INELIGIBLE';
    await app.save(); await audit(req,'APPLICATION_ELIGIBILITY_RECORDED','Application',app.id,{eligibility:b.eligibility,reason:b.reason,requiredDocumentsComplete:docsComplete(app.documents as any,requiredDocumentTypes(c)),paymentStatus:app.paymentStatus});
    res.json({application:app,message:'Eligibility assessment recorded. No automatic score cutoff was applied.'});
  } catch(e) { next(e); }
});

router.post('/:id/ready-for-review', allowRoles('ADMISSION_OFFICER'), async (req,res,next) => {
  try {
    const b = z.object({reason:z.string().trim().min(5).max(1000)}).parse(req.body);
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({message:'Invalid application identifier.'});
    const app = await Application.findById(req.params.id); if (!app) return res.status(404).json({message:'Application not found.'});
    if (app.assignedOfficerId && String(app.assignedOfficerId)!==req.user!.id) return res.status(403).json({message:'This application is assigned to another Admission Officer.'});
    const c = await admissionsConfig();
    if (app.paymentStatus!=='VERIFIED' || !docsComplete(app.documents as any,requiredDocumentTypes(c)) || app.eligibility!=='ELIGIBLE') return res.status(409).json({message:'The application must have verified payment, all required documents and an explicit ELIGIBLE assessment before it can be marked ready for review.'});
    if (app.screeningBatchId) return res.status(409).json({message:'This application has already entered a screening batch.'});
    app.status='READY_FOR_REVIEW'; app.reviewNote=b.reason; await app.save();
    await applicationEvent(String(app.applicantId),'ready',`Your application ${app.applicationNumber} has completed the document-completeness stage and is ready for the next review stage. This is not an admission offer.`,'Application Ready for Review');
    await audit(req,'APPLICATION_READY_FOR_REVIEW','Application',app.id,{reason:b.reason,rulesVersion:c.screeningRulesVersion||'not-configured'});
    res.json({application:app,message:'Application marked ready for review. No admission decision has been made.'});
  } catch(e) { next(e); }
});

router.post('/screening-batches', allowRoles('ADMISSION_OFFICER'), async (req,res,next) => {
  const session = await mongoose.startSession();
  try {
    const b = z.object({session:z.string().trim().min(4).max(30),batchKey:z.string().trim().min(8).max(120)}).parse(req.body);
    const existing = await ScreeningBatch.findOne({batchKey:b.batchKey});
    if (existing) {
      if (existing.session !== b.session) return res.status(409).json({message:'This idempotency key is already associated with a different admission session. Refresh and submit a new batch request.'});
      return res.json({batch:existing,idempotentReplay:true,message:'This batch request was already processed; no duplicate batch was created.'});
    }
    const c = await admissionsConfig();
    if (!c.session || b.session !== c.session) return res.status(409).json({message:'Screening batches can only be created for the currently configured admission session.'});
    if (!c.screeningRulesVersion || c.screeningRulesVersion === 'not-configured') return res.status(409).json({message:'Configure and version the institution’s screening rules before creating a screening batch. No scoring cutoff is invented by this system.'});
    let batch: any = null;
    await session.withTransaction(async () => {
      // Select and claim inside the same transaction: two officers cannot successfully claim the same applications.
      const eligible = await Application.find({session:b.session,eligibility:'ELIGIBLE',paymentStatus:'VERIFIED',screeningBatchId:{$in:[null]},status:{$in:['READY_FOR_REVIEW','UNDER_REVIEW']}}).sort({submittedAt:1,_id:1}).limit(100).select('_id').session(session);
      if (!eligible.length) throw Object.assign(new Error('No eligible, paid, unprocessed applications are available for this session.'),{status:409});
      const selected = eligible.map(x=>x._id);
      const [created] = await ScreeningBatch.create([{batchKey:b.batchKey,session:b.session,status:'PROCESSING',applicationIds:selected,count:selected.length,rulesVersion:c.screeningRulesVersion,createdBy:req.user!.id}],{session});
      const update = await Application.updateMany({_id:{$in:selected},screeningBatchId:{$in:[null]},eligibility:'ELIGIBLE',paymentStatus:'VERIFIED',status:{$in:['READY_FOR_REVIEW','UNDER_REVIEW']}},{$set:{screeningBatchId:created._id,status:'SCREENING_IN_PROGRESS',screeningProcessedAt:new Date(),screeningRulesVersion:c.screeningRulesVersion}},{session});
      if (update.modifiedCount !== selected.length) throw Object.assign(new Error('Some applications changed during batch creation. No partial batch was committed; refresh and try again.'),{status:409});
      created.status='COMPLETED'; created.completedAt=new Date(); await created.save({session}); batch=created;
    });
    await audit(req,'ADMISSION_SCREENING_BATCH_CREATED','ScreeningBatch',String(batch._id),{session:b.session,count:batch.count,rulesVersion:c.screeningRulesVersion});
    const available = await Application.countDocuments({session:b.session,eligibility:'ELIGIBLE',paymentStatus:'VERIFIED',screeningBatchId:{$in:[null]},status:{$in:['READY_FOR_REVIEW','UNDER_REVIEW']}});
    res.status(201).json({batch,message:`Created screening batch with ${batch.count} application(s). ${batch.count===100?'The batch contains 100 eligible applications.':'Fewer than 100 eligible applications were available, so the remaining applications were included.'} ${available>0?`${available} eligible application(s) remain for a later batch. `:''}Screening outcomes still require human review.`});
  } catch(e:any) { if(e?.code===11000) { const existing=await ScreeningBatch.findOne({batchKey:req.body?.batchKey}); if(existing)return res.json({batch:existing,idempotentReplay:true}); } next(e); }
  finally { await session.endSession(); }
});

router.post('/screening-batches/:id/recover', allowRoles('ADMISSION_OFFICER'), async (req,res,next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({message:'Invalid screening batch identifier.'});
    const batch = await ScreeningBatch.findById(req.params.id);
    if (!batch) return res.status(404).json({message:'Screening batch not found.'});
    if (batch.status !== 'PROCESSING' && batch.status !== 'FAILED') return res.status(409).json({message:`Only an incomplete or failed batch can be recovered; current status is ${batch.status}.`});
    const c = await admissionsConfig();
    if (batch.session !== c.session || batch.rulesVersion !== c.screeningRulesVersion) return res.status(409).json({message:'The batch session or screening policy version no longer matches the active policy. Registrar review is required; the system will not silently process it under changed rules.'});
    batch.status = 'PROCESSING'; await batch.save();
    await Application.updateMany(
      {_id:{$in:batch.applicationIds},session:batch.session,screeningBatchId:{$in:[null]},eligibility:'ELIGIBLE',paymentStatus:'VERIFIED',status:{$in:['READY_FOR_REVIEW','UNDER_REVIEW']}},
      {$set:{screeningBatchId:batch._id,status:'SCREENING_IN_PROGRESS',screeningProcessedAt:new Date(),screeningRulesVersion:batch.rulesVersion}},
    );
    const claimed = await Application.find({screeningBatchId:batch._id,session:batch.session}).select('_id');
    batch.applicationIds = claimed.map(x=>x._id) as any; batch.count = claimed.length; batch.status = claimed.length ? 'COMPLETED' : 'FAILED'; batch.completedAt = new Date(); await batch.save();
    await audit(req,'ADMISSION_SCREENING_BATCH_RECOVERED','ScreeningBatch',batch.id,{session:batch.session,count:batch.count,rulesVersion:batch.rulesVersion,status:batch.status});
    if (!claimed.length) return res.status(409).json({batch,message:'No eligible applications could be recovered into this batch. The batch remains failed and is retained for audit.'});
    res.json({batch,message:`Recovered screening batch with ${batch.count} application(s). Human review is still required; no applicant was automatically admitted or rejected.`});
  } catch(e) { next(e); }
});

router.get('/screening-batches', allowRoles('ADMISSION_OFFICER','REGISTRAR'), async (req,res,next) => {
  try { const session=String(req.query.session||''); const query:Record<string,unknown>={}; if(session)query.session=session; const batches=await ScreeningBatch.find(query).sort({createdAt:-1}).limit(100).populate('createdBy','fullName email'); res.json({batches}); }
  catch(e){next(e);}
});

router.post('/:id/decision', allowRoles('ADMISSION_OFFICER'), async (req,res,next) => {
  const dbSession = await mongoose.startSession();
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({message:'Invalid application identifier.'});
    const b = z.object({outcome:z.enum(['DECISION_PENDING','OFFERED','REJECTED','INELIGIBLE','UNSUCCESSFUL']),reason:z.string().trim().min(10).max(2000),acceptanceDeadline:z.string().datetime().optional()}).parse(req.body);
    const c=await admissionsConfig(); let saved:any=null; const released:Array<{programme:string;session:string}>=[];
    if(b.outcome==='OFFERED' && (!b.acceptanceDeadline || new Date(b.acceptanceDeadline).getTime()<=Date.now())) return res.status(400).json({message:'A future offer acceptance deadline is required.'});
    await dbSession.withTransaction(async()=>{
      const app=await Application.findById(req.params.id).session(dbSession); if(!app)throw Object.assign(new Error('Application not found.'),{status:404});
      if(app.assignedOfficerId && String(app.assignedOfficerId)!==req.user!.id)throw Object.assign(new Error('Only the assigned Admission Officer can record this decision.'),{status:403});
      if(['ACCEPTED','DECLINED','REJECTED','INELIGIBLE','UNSUCCESSFUL'].includes(app.status))throw Object.assign(new Error('This application already has a terminal outcome. Use the institution’s correction/appeal process rather than overwriting it.'),{status:409});
      if(b.outcome==='OFFERED'){
        if((app.offers as any[]).some(o=>o.kind==='PRIMARY'&&['ISSUED','ACCEPTED'].includes(o.status)))throw Object.assign(new Error('An active primary offer already exists for this application.'),{status:409});
        if(app.eligibility!=='ELIGIBLE'||app.paymentStatus!=='VERIFIED'||!docsComplete(app.documents as any,requiredDocumentTypes(c)))throw Object.assign(new Error('An offer requires verified payment, complete documents and an explicit eligible assessment.'),{status:409});
        const programme=app.firstChoiceCourse;const capacity=Number(c.programmeCapacities?.[programme]);
        if(!Number.isInteger(capacity)||capacity<1)throw Object.assign(new Error('No valid capacity is configured for the first-choice programme. Ask the authorized office to configure capacity before issuing an offer.'),{status:409});
        try{await ProgrammeCapacity.updateOne({session:app.session,programme},{$setOnInsert:{session:app.session,programme,capacity,reserved:0}},{upsert:true,session:dbSession});}catch(error:any){if(error?.code!==11000)throw error;}
        const row=await ProgrammeCapacity.findOne({session:app.session,programme}).session(dbSession);if(!row)throw Object.assign(new Error('Programme capacity could not be initialized.'),{status:503});
        if(row.reserved>capacity)throw Object.assign(new Error('Configured programme capacity is below existing reservations. Registrar reconciliation is required.'),{status:409});
        await ProgrammeCapacity.updateOne({session:app.session,programme,reserved:{$lte:capacity}},{$set:{capacity}},{session:dbSession});
        const seat=await ProgrammeCapacity.findOneAndUpdate({session:app.session,programme,reserved:{$lt:capacity}},{$inc:{reserved:1}},{new:true,session:dbSession});
        if(!seat)throw Object.assign(new Error('The configured capacity for this programme has been reached.'),{status:409});
        app.offers.push({kind:'PRIMARY',programme,status:'ISSUED',issuedBy:new mongoose.Types.ObjectId(req.user!.id),issuedAt:new Date(),acceptanceDeadline:new Date(b.acceptanceDeadline!),eligibilityConfirmed:true,eligibilityReason:b.reason} as any);app.status='OFFERED';
      }else{
        app.status=b.outcome;
        if(['REJECTED','INELIGIBLE','UNSUCCESSFUL'].includes(b.outcome))for(const offer of app.offers as any[]){if(['ISSUED','ACCEPTED'].includes(offer.status)){if(offer.status==='ISSUED'){released.push({programme:offer.programme,session:app.session});offer.status='REVOKED';}}}
      }
      app.decisionHistory.push({outcome:b.outcome,reason:b.reason,decidedBy:new mongoose.Types.ObjectId(req.user!.id),decidedByEmail:req.user!.email,decidedAt:new Date(),policyVersion:c.screeningRulesVersion||'admissions-decisions-v1'} as any);
      await app.save({session:dbSession});saved=app;
      for(const item of released)await ProgrammeCapacity.updateOne({session:item.session,programme:item.programme,reserved:{$gt:0}},{$inc:{reserved:-1}},{session:dbSession});
    });
    await audit(req,'ADMISSION_DECISION_RECORDED','Application',String(saved._id),{outcome:b.outcome,reason:b.reason,offerDeadline:b.acceptanceDeadline,capacityReservation:b.outcome==='OFFERED'});
    await notify(String(saved.applicantId),'Admission workflow updated',`Your application ${saved.applicationNumber} has a status update: ${saved.status}. Sign in to view the official details.`).catch(error=>console.error('Admission decision notification failed:',error));
    if(b.outcome==='DECISION_PENDING')await applicationEvent(String(saved.applicantId),'decision',`An admission decision is pending for application ${saved.applicationNumber}. Please check the applicant portal for updates.`,'Admission Decision Pending');
    res.json({application:safeApplication(saved,true),message:`Decision recorded: ${b.outcome}.`});
  }catch(e){next(e);}finally{await dbSession.endSession();}
});

router.post('/:id/alternative-offer', allowRoles('ADMISSION_OFFICER'), async (req,res,next) => {
  const dbSession=await mongoose.startSession();
  try{
    if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:'Invalid application identifier.'});
    const b=z.object({programme:z.string().trim().min(2).max(160),eligibilityConfirmed:z.literal(true),eligibilityReason:z.string().trim().min(10).max(2000),acceptanceDeadline:z.string().datetime()}).parse(req.body);
    if(new Date(b.acceptanceDeadline).getTime()<=Date.now())return res.status(400).json({message:'A future acceptance deadline is required.'});
    const c=await admissionsConfig();let saved:any=null;let reservedCount=0;
    await dbSession.withTransaction(async()=>{
      const app=await Application.findById(req.params.id).session(dbSession);if(!app)throw Object.assign(new Error('Application not found.'),{status:404});
      if(app.assignedOfficerId&&String(app.assignedOfficerId)!==req.user!.id)throw Object.assign(new Error('This application is assigned to another Admission Officer.'),{status:403});
      if(['ACCEPTED','DECLINED','REJECTED','INELIGIBLE','UNSUCCESSFUL'].includes(app.status))throw Object.assign(new Error('This application has a terminal outcome and cannot receive a new offer.'),{status:409});
      if(app.eligibility!=='ELIGIBLE'||app.paymentStatus!=='VERIFIED'||!docsComplete(app.documents as any,requiredDocumentTypes(c)))throw Object.assign(new Error('Alternative offers require a verified fee, complete documents and an explicit eligible assessment.'),{status:409});
      const capacity=Number(c.programmeCapacities?.[b.programme]);if(!Number.isInteger(capacity)||capacity<1)throw Object.assign(new Error('No valid capacity has been configured for this alternative programme. Ask the authorized university office to configure capacity first.'),{status:409});
      if(app.offers.some(o=>o.programme.toLowerCase()===b.programme.toLowerCase()&&['ISSUED','ACCEPTED'].includes(o.status)))throw Object.assign(new Error('An active offer already exists for this programme on this application.'),{status:409});
      try{await ProgrammeCapacity.updateOne({session:app.session,programme:b.programme},{$setOnInsert:{session:app.session,programme:b.programme,capacity,reserved:0}},{upsert:true,session:dbSession});}catch(error:any){if(error?.code!==11000)throw error;}
      const capacityRow=await ProgrammeCapacity.findOne({session:app.session,programme:b.programme}).session(dbSession);if(!capacityRow)throw Object.assign(new Error('Programme capacity could not be initialized. Please retry.'),{status:503});
      if(capacityRow.reserved>capacity)throw Object.assign(new Error(`The configured capacity (${capacity}) is below ${capacityRow.reserved} existing reservations. Ask the Registrar to reconcile existing offers first.`),{status:409});
      await ProgrammeCapacity.updateOne({session:app.session,programme:b.programme,reserved:{$lte:capacity}},{$set:{capacity}},{session:dbSession});
      const seat=await ProgrammeCapacity.findOneAndUpdate({session:app.session,programme:b.programme,reserved:{$lt:capacity}},{$inc:{reserved:1}},{new:true,session:dbSession});if(!seat)throw Object.assign(new Error('The configured capacity for this alternative programme has been reached.'),{status:409});reservedCount=seat.reserved;
      app.offers.push({kind:'ALTERNATIVE',programme:b.programme,status:'ISSUED',issuedBy:new mongoose.Types.ObjectId(req.user!.id),issuedAt:new Date(),acceptanceDeadline:new Date(b.acceptanceDeadline),eligibilityConfirmed:true,eligibilityReason:b.eligibilityReason} as any);app.status='ALTERNATIVE_OFFERED';
      app.decisionHistory.push({outcome:'ALTERNATIVE_OFFER_ISSUED',reason:b.eligibilityReason,decidedBy:new mongoose.Types.ObjectId(req.user!.id),decidedByEmail:req.user!.email,decidedAt:new Date(),policyVersion:c.screeningRulesVersion||'admissions-decisions-v1'} as any);
      await app.save({session:dbSession});saved=app;
    });
    await audit(req,'ALTERNATIVE_OFFER_ISSUED','Application',String(saved._id),{programme:b.programme,capacity:Number(c.programmeCapacities?.[b.programme]),reservedSeats:reservedCount,acceptanceDeadline:b.acceptanceDeadline,eligibilityReason:b.eligibilityReason});
    await notify(String(saved.applicantId),'Alternative programme offer issued',`An alternative programme offer is available for ${saved.applicationNumber}. Sign in to review the programme and acceptance deadline.`).catch(error=>console.error('Alternative offer notification failed:',error));
    res.json({application:safeApplication(saved,true),message:'Alternative offer issued. The applicant must explicitly accept or decline before the deadline.'});
  }catch(e){next(e);}finally{await dbSession.endSession();}
});

router.post('/:id/offers/:offerId/consent', allowRoles('APPLICANT'), async (req,res,next) => {
  const dbSession=await mongoose.startSession();
  try{
    if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:'Invalid application identifier.'});
    const b=z.object({decision:z.enum(['ACCEPT','DECLINE'])}).parse(req.body);let saved:any=null;let offerSnapshot:any=null;let expired=false;const released:string[]=[];
    await dbSession.withTransaction(async()=>{
      const app=await Application.findOne({_id:req.params.id,applicantId:req.user!.id}).session(dbSession);if(!app)throw Object.assign(new Error('Application not found.'),{status:404});
      const offer=(app.offers as any[]).find(o=>String(o._id)===req.params.offerId);if(!offer)throw Object.assign(new Error('Offer not found.'),{status:404});
      if(offer.status!=='ISSUED')throw Object.assign(new Error(`This offer is already ${String(offer.status).toLowerCase()}.`),{status:409});
      offerSnapshot={_id:String(offer._id),programme:offer.programme,kind:offer.kind};
      if(new Date(offer.acceptanceDeadline).getTime()<Date.now()){
        offer.status='EXPIRED';expired=true;released.push(offer.programme);
      }else{
        offer.status=b.decision==='ACCEPT'?'ACCEPTED':'DECLINED';offer.consentAt=new Date();
        const remainingIssued=(app.offers as any[]).some(other=>String(other._id)!==req.params.offerId&&other.status==='ISSUED');
        app.status=b.decision==='ACCEPT'?'ACCEPTED':remainingIssued?((app.offers as any[]).some(other=>String(other._id)!==req.params.offerId&&other.kind==='ALTERNATIVE'&&other.status==='ISSUED')?'ALTERNATIVE_OFFERED':'OFFERED'):'DECLINED';
        if(b.decision==='ACCEPT')for(const other of app.offers as any[]){if(String(other._id)!==req.params.offerId&&other.status==='ISSUED'){other.status='REVOKED';released.push(other.programme);}}
        else released.push(offer.programme);
      }
      if (expired && !(app.offers as any[]).some(other => other.status === 'ISSUED')) app.status = 'DECISION_PENDING';
      await app.save({session:dbSession});
      // An applicant becomes an admitted student only after explicit acceptance of a valid offer.
      // Keep the account transition in the same transaction as the canonical application decision.
      if (!expired && b.decision === 'ACCEPT') {
        const applicant = await User.findById(app.applicantId).session(dbSession);
        if (!applicant) throw Object.assign(new Error('Applicant account not found; the offer acceptance could not be finalized.'),{status:409});
        if (applicant.role==='ADMITTED_STUDENT' && applicant.admissionSession && applicant.admissionSession!==app.session) throw Object.assign(new Error(`This account is already admitted for ${applicant.admissionSession} and cannot switch its admitted session by accepting another offer.`),{status:409});
        if (!['APPLICANT','ADMITTED_STUDENT'].includes(applicant.role)) throw Object.assign(new Error('This account has already moved beyond the applicant stage and cannot accept another admission offer.'),{status:409});
        applicant.role = 'ADMITTED_STUDENT';
        applicant.admissionSession = app.session;
        // Preserve the accepted programme/faculty on the student account so the Registrar's
        // department-code mapping can be enforced when the student generates a matric number.
        applicant.department = String(offerSnapshot.programme || app.firstChoiceCourse || '').trim();
        applicant.faculty = String(app.faculty || '').trim();
        await applicant.save({session:dbSession});
      }
      for(const programme of released)await ProgrammeCapacity.updateOne({session:app.session,programme,reserved:{$gt:0}},{$inc:{reserved:-1}},{session:dbSession});
      saved=app;
    });
    await audit(req,expired?'ADMISSION_OFFER_EXPIRED':b.decision==='ACCEPT'?'ADMISSION_OFFER_ACCEPTED':'ADMISSION_OFFER_DECLINED','Application',String(saved._id),{offerId:req.params.offerId,programme:offerSnapshot.programme,kind:offerSnapshot.kind,decision:b.decision,expired,studentLifecycleTransition:b.decision==='ACCEPT'&&!expired?'APPLICANT_TO_ADMITTED_STUDENT':null,otherOffersRevoked:Math.max(0,released.length-(expired||b.decision==='DECLINE'?1:0))});
    if(expired)return res.status(410).json({application:safeApplication(saved,true),message:'The offer acceptance deadline has passed; the offer expired and its capacity reservation was released.'});
    await notify(String(saved.applicantId),'Offer response recorded',`Your response to the ${offerSnapshot.kind.toLowerCase()} offer for ${offerSnapshot.programme} has been recorded.`).catch(error=>console.error('Offer response notification failed:',error));
    res.json({application:safeApplication(saved,true),message:b.decision==='ACCEPT'?'Offer accepted successfully. Your account is now an Admitted Student; other active offers were revoked.':'Offer declined successfully.'});
  }catch(e){next(e);}finally{await dbSession.endSession();}
});

export default router;

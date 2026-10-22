import { Router } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import { randomUUID as uuidv4 } from 'node:crypto';
import { v2 as cloudinary } from 'cloudinary';
import { z } from 'zod';
import { authenticate, allowRoles } from '../middleware/auth.js';
import { RecordModel } from '../models/Record.js';
import { User } from '../models/User.js';
import { env } from '../config/env.js';
import { initializePaystackPayment, verifyPaystackPayment } from '../services/paystack.js';
import { audit } from '../services/audit.js';
import { notify, queueEmailUserIfEnabled } from '../services/notifications.js';

const router = Router();
router.use(authenticate);
const staff = ['HOSTEL_ADMIN','BURSARY','REGISTRAR'];
const studentRoles = ['REGISTERED_STUDENT','STUDENT'] as const;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 3 }, fileFilter: (_req,file,cb) => {
  if (!['image/jpeg','image/png','image/webp'].includes(file.mimetype)) return cb(new Error('Hostel photos must be JPEG, PNG, or WebP images.'));
  cb(null,true);
}});
const listingModule = 'hostel-listing';
const reservationMinutes = 60;

function configureCloudinary() {
  cloudinary.config({ cloud_name: env.cloudinaryCloudName, api_key: env.cloudinaryApiKey, api_secret: env.cloudinaryApiSecret, secure: true });
  if (!env.cloudinaryCloudName || !env.cloudinaryApiKey || !env.cloudinaryApiSecret) throw Object.assign(new Error('Hostel photo uploads require Cloudinary to be configured on the server.'), { status: 503 });
}
function uploadPhoto(buffer: Buffer): Promise<{url:string;publicId:string}> {
  configureCloudinary();
  return new Promise((resolve,reject) => {
    const stream = cloudinary.uploader.upload_stream({ folder:'crestfield/hostels', resource_type:'image', transformation:[{width:1800,height:1200,crop:'limit'},{quality:'auto',fetch_format:'auto'}] }, (error,result) => {
      if (error || !result) return reject(error || new Error('Could not upload hostel image.'));
      resolve({url:result.secure_url,publicId:result.public_id});
    });
    stream.end(buffer);
  });
}
async function sendRoleNotice(role:string,title:string,message:string,eventKey:string) {
  const users=await User.find({role,status:'ACTIVE'}).select('_id');
  for (const u of users) { await notify(String(u._id),title,message); await queueEmailUserIfEnabled(String(u._id),`${eventKey}:${String(u._id)}`,title,message); }
}
function canViewListing(record:any,role:string) {
  return staff.includes(role) || ['PUBLISHED_INACTIVE','PUBLISHED_ACTIVE','DEACTIVATED'].includes(String(record.status));
}
function activeReservations(data:any,now=new Date()) {
  return (Array.isArray(data?.reservations)?data.reservations:[]).filter((r:any)=>r.status==='RESERVED' && new Date(r.expiresAt).getTime()>now.getTime());
}

// Upload actual hostel photos; the listing accepts two or three uploaded images.
router.post('/images', allowRoles('HOSTEL_ADMIN'), upload.array('photos',3), async (req,res,next) => {
  try {
    const files=(req.files||[]) as Express.Multer.File[];
    if (!files.length) return res.status(400).json({message:'Choose at least one hostel photo to upload.'});
    const images=[] as {url:string;publicId:string}[];
    for (const file of files) images.push(await uploadPhoto(file.buffer));
    await audit(req,'HOSTEL_PHOTOS_UPLOADED','hostel-listing',undefined,{count:images.length});
    res.status(201).json({images});
  } catch(e) { next(e); }
});

// Student-visible listings are published only; unpublished fee proposals remain staff-only.
router.get('/listings', async (req,res,next) => {
  try {
    const role=req.user!.role;
    const query:any={module:listingModule};
    if (!staff.includes(role)) query.status={$in:['PUBLISHED_INACTIVE','PUBLISHED_ACTIVE','DEACTIVATED']};
    const rows=await RecordModel.find(query).sort({createdAt:-1}).limit(300).lean();
    const listings=rows.filter((r:any)=>canViewListing(r,role)).map((r:any)=>{
      const data:any=r.data||{};
      return {_id:String(r._id),title:r.title,status:r.status,createdAt:r.createdAt,updatedAt:r.updatedAt,
        name:data.name,location:data.location,category:data.category,description:data.description,amenities:data.amenities||[],rules:data.rules||'',roomTypes:data.roomTypes||[],totalBeds:Number(data.totalBeds||0),images:data.images||[],session:data.session,applicationOpensAt:data.applicationOpensAt,applicationClosesAt:data.applicationClosesAt,
        proposedFee:data.proposedFee,approvedFee:data.approvedFee,feeCurrency:'NGN',feeApprovalStage:data.feeApprovalStage,feeApprovalHistory:data.feeApprovalHistory||[],published:['PUBLISHED_INACTIVE','PUBLISHED_ACTIVE','DEACTIVATED'].includes(r.status),bookingActive:r.status==='PUBLISHED_ACTIVE'&&data.bookingActive===true,activeReservations:activeReservations(data).length,availableBeds:Math.max(0,Number(data.totalBeds||0)-activeReservations(data).length-(Array.isArray(data.reservations)?data.reservations.filter((x:any)=>x.status==='CONFIRMED').length:0)),deactivated:r.status==='DEACTIVATED',myReservation:(data.reservations||[]).filter((x:any)=>String(x.studentId)===req.user!.id).sort((a:any,b:any)=>new Date(b.createdAt||0).getTime()-new Date(a.createdAt||0).getTime())[0]||null};
    });
    res.json({listings});
  } catch(e) { next(e); }
});

router.get('/mine', allowRoles('HOSTEL_ADMIN','BURSARY','REGISTRAR'), async (req,res,next) => {
  try { const records=await RecordModel.find({module:listingModule}).sort({createdAt:-1}).limit(300).lean(); res.json({listings:records}); }
  catch(e){next(e);}
});

const listingSchema=z.object({
  name:z.string().trim().min(2).max(120), category:z.string().trim().min(2).max(80), location:z.string().trim().min(2).max(180), description:z.string().trim().min(20).max(4000),
  session:z.string().trim().min(4).max(30), proposedFee:z.number().positive().max(10000000), totalBeds:z.number().int().min(1).max(10000),
  roomTypes:z.array(z.object({name:z.string().trim().min(1).max(80),capacity:z.number().int().min(1).max(20),description:z.string().trim().max(500).optional()})).min(1).max(20),
  amenities:z.array(z.string().trim().min(1).max(80)).max(40).default([]), rules:z.string().trim().max(3000).default(''), images:z.array(z.object({url:z.string().url(),publicId:z.string().min(1)})).min(2).max(3),
  applicationOpensAt:z.string().datetime().optional(), applicationClosesAt:z.string().datetime().optional()
});
router.post('/listings', allowRoles('HOSTEL_ADMIN'), async (req,res,next) => {
  try {
    const b=listingSchema.parse(req.body);
    if (b.applicationOpensAt&&b.applicationClosesAt&&new Date(b.applicationClosesAt)<=new Date(b.applicationOpensAt)) return res.status(400).json({message:'Application closing time must be after the opening time.'});
    const title=`${b.name} — ${b.session}`;
    const record=await RecordModel.create({module:listingModule,title,status:'FEE_PENDING_BURSARY',reference:`HOSTEL:${b.session}:${new mongoose.Types.ObjectId().toString()}`,ownerId:req.user!.id,createdBy:req.user!.id,updatedBy:req.user!.id,data:{...b,images:b.images,bookingActive:false,feeApprovalStage:'PENDING_BURSARY',feeApprovalHistory:[{stage:'HOSTEL_ADMIN_PROPOSED',by:req.user!.id,at:new Date(),fee:b.proposedFee}],reservations:[],confirmedAllocations:[],createdByRole:req.user!.role}});
    await audit(req,'HOSTEL_LISTING_SUBMITTED_FOR_FEE_REVIEW',listingModule,record.id,{name:b.name,session:b.session,proposedFee:b.proposedFee});
    await sendRoleNotice('BURSARY','Hostel fee proposal awaiting review',`${b.name} (${b.session}) has been submitted for Bursary review. Proposed fee: ₦${b.proposedFee.toLocaleString()}.` ,`hostel-fee-proposal:${record.id}`);
    res.status(201).json({listing:record,message:'Hostel listing submitted. Students cannot see it until the approved fee is published.'});
  } catch(e){next(e);}
});

router.patch('/listings/:id/bursary-review', allowRoles('BURSARY'), async (req,res,next) => {
  try {
    const b=z.object({action:z.enum(['FORWARD_TO_REGISTRAR','RETURN_FOR_CORRECTION']),reason:z.string().trim().min(5).max(1000).optional()}).parse(req.body);
    if(b.action==='RETURN_FOR_CORRECTION'&&!b.reason) return res.status(400).json({message:'Provide a reason when returning a hostel proposal for correction.'});
    const row=await RecordModel.findOne({_id:req.params.id,module:listingModule,status:'FEE_PENDING_BURSARY'});
    if(!row) return res.status(404).json({message:'Hostel proposal is not waiting for Bursary review.'});
    row.status=b.action==='FORWARD_TO_REGISTRAR'?'FEE_PENDING_REGISTRAR':'FEE_RETURNED_TO_HOSTEL_ADMIN';
    const data:any=row.data; data.feeApprovalStage=row.status; data.feeApprovalHistory=[...(data.feeApprovalHistory||[]),{stage:b.action,by:req.user!.id,at:new Date(),reason:b.reason||''}]; row.data=data; row.updatedBy=new mongoose.Types.ObjectId(req.user!.id); await row.save();
    await audit(req,'HOSTEL_FEE_BURSARY_REVIEW',listingModule,row.id,{action:b.action,reason:b.reason});
    if(b.action==='FORWARD_TO_REGISTRAR') await sendRoleNotice('REGISTRAR','Hostel fee awaiting final approval',`${data.name} (${data.session}) fee proposal of ₦${Number(data.proposedFee).toLocaleString()} has been reviewed by Bursary and requires your decision.`,`hostel-fee-registrar:${row.id}`);
    else await notify(String(row.ownerId),'Hostel fee proposal returned',`Bursary returned ${data.name} for correction: ${b.reason}`);
    res.json({listing:row,message:b.action==='FORWARD_TO_REGISTRAR'?'Fee proposal forwarded to the Registrar for final approval.':'Proposal returned to the Hostel Administrator for correction.'});
  }catch(e){next(e);}
});

router.patch('/listings/:id/registrar-decision', allowRoles('REGISTRAR'), async (req,res,next) => {
  try {
    const b=z.object({decision:z.enum(['APPROVE','REJECT']),reason:z.string().trim().min(5).max(1000)}).parse(req.body);
    const row=await RecordModel.findOne({_id:req.params.id,module:listingModule,status:'FEE_PENDING_REGISTRAR'});
    if(!row) return res.status(404).json({message:'This fee proposal has not been forwarded by Bursary for final approval.'});
    const data:any=row.data; data.feeApprovalHistory=[...(data.feeApprovalHistory||[]),{stage:b.decision==='APPROVE'?'REGISTRAR_APPROVED':'REGISTRAR_REJECTED',by:req.user!.id,at:new Date(),reason:b.reason}]; data.feeApprovalStage=b.decision==='APPROVE'?'REGISTRAR_APPROVED':'REGISTRAR_REJECTED'; data.registrarDecisionReason=b.reason; data.registrarDecisionAt=new Date();
    row.status=b.decision==='APPROVE'?'FEE_APPROVED_AWAITING_BURSARY':'FEE_REJECTED_AWAITING_BURSARY'; if(b.decision==='APPROVE') data.approvedFee=Number(data.proposedFee); row.data=data; row.updatedBy=new mongoose.Types.ObjectId(req.user!.id); await row.save();
    await audit(req,'HOSTEL_FEE_REGISTRAR_DECISION',listingModule,row.id,{decision:b.decision,reason:b.reason,approvedFee:data.approvedFee||null});
    // Registrar's decision is not communicated directly to the Hostel Administrator; Bursary must relay it.
    await sendRoleNotice('BURSARY','Registrar hostel fee decision requires communication',`${data.name} (${data.session}): Registrar ${b.decision==='APPROVE'?'approved':'rejected'} the proposed fee. ${b.reason} Use the hostel fee workflow to communicate the outcome to the Hostel Administrator.`,`hostel-fee-decision-bursary:${row.id}`);
    res.json({listing:row,message:'Registrar decision recorded. Bursary must communicate the decision to the Hostel Administrator before publication can proceed.'});
  }catch(e){next(e);}
});

router.patch('/listings/:id/resubmit', allowRoles('HOSTEL_ADMIN'), async (req,res,next) => {
  try {
    const b=z.object({proposedFee:z.number().positive().max(10000000),correctionNote:z.string().trim().min(5).max(1000)}).parse(req.body);
    const row=await RecordModel.findOne({_id:req.params.id,module:listingModule,status:'FEE_RETURNED_TO_HOSTEL_ADMIN',ownerId:req.user!.id});
    if(!row) return res.status(404).json({message:'Only your returned hostel proposal can be resubmitted.'});
    const data:any=row.data; data.proposedFee=b.proposedFee; data.approvedFee=undefined; data.feeApprovalStage='PENDING_BURSARY'; data.feeApprovalHistory=[...(data.feeApprovalHistory||[]),{stage:'HOSTEL_ADMIN_RESUBMITTED',by:req.user!.id,at:new Date(),fee:b.proposedFee,reason:b.correctionNote}]; row.status='FEE_PENDING_BURSARY'; row.data=data; row.updatedBy=new mongoose.Types.ObjectId(req.user!.id); await row.save();
    await audit(req,'HOSTEL_FEE_PROPOSAL_RESUBMITTED',listingModule,row.id,{proposedFee:b.proposedFee,correctionNote:b.correctionNote});
    await sendRoleNotice('BURSARY','Corrected hostel fee proposal awaiting review',`${data.name} (${data.session}) was resubmitted. Proposed fee: ₦${b.proposedFee.toLocaleString()}.`,`hostel-fee-resubmitted:${row.id}:${Date.now()}`);
    res.json({listing:row,message:'Corrected fee proposal has been resubmitted to Bursary.'});
  }catch(e){next(e);}
});

router.patch('/listings/:id/communicate-decision', allowRoles('BURSARY'), async (req,res,next) => {
  try {
    const b=z.object({message:z.string().trim().min(5).max(1000)}).parse(req.body);
    const row=await RecordModel.findOne({_id:req.params.id,module:listingModule,status:{$in:['FEE_APPROVED_AWAITING_BURSARY','FEE_REJECTED_AWAITING_BURSARY']}});
    if(!row) return res.status(409).json({message:'There is no Registrar decision awaiting Bursary communication.'});
    const data:any=row.data; const approved=row.status==='FEE_APPROVED_AWAITING_BURSARY';
    data.feeApprovalHistory=[...(data.feeApprovalHistory||[]),{stage:'BURSARY_COMMUNICATED_DECISION',by:req.user!.id,at:new Date(),message:b.message,decision:approved?'APPROVED':'REJECTED'}]; data.feeApprovalStage=approved?'FEE_APPROVED_COMMUNICATED':'FEE_REJECTED_COMMUNICATED'; data.bursaryCommunicatedAt=new Date(); data.bursaryCommunicatedBy=req.user!.id; data.bursaryCommunication=b.message;
    row.status=approved?'FEE_APPROVED_AWAITING_HOSTEL_ADMIN':'FEE_REJECTED'; row.data=data; row.updatedBy=new mongoose.Types.ObjectId(req.user!.id); await row.save();
    await audit(req,'HOSTEL_FEE_DECISION_COMMUNICATED_BY_BURSARY',listingModule,row.id,{decision:approved?'APPROVED':'REJECTED',message:b.message});
    const title=approved?'Hostel fee approved — ready to publish':'Hostel fee proposal rejected'; const msg=`${data.name} (${data.session}): ${approved?'Registrar approved the fee. You may now publish the listing; booking will remain closed until you activate it.':'Registrar rejected the fee proposal.'} Bursary message: ${b.message}`;
    await notify(String(row.ownerId),title,msg); await queueEmailUserIfEnabled(String(row.ownerId),`hostel-fee-communicated:${row.id}`,title,msg);
    res.json({listing:row,message:approved?'Decision communicated to the Hostel Administrator. The approved fee can now be published.':'Rejection communicated to the Hostel Administrator.'});
  }catch(e){next(e);}
});

router.patch('/listings/:id/publish', allowRoles('HOSTEL_ADMIN'), async (req,res,next) => {
  try {
    const row=await RecordModel.findOne({_id:req.params.id,module:listingModule,status:'FEE_APPROVED_AWAITING_HOSTEL_ADMIN'});
    if(!row) return res.status(409).json({message:'Only a hostel with final Registrar fee approval can be published.'});
    const data:any=row.data; data.bookingActive=false; data.publishedAt=new Date(); data.feeApprovalStage='PUBLISHED_AWAITING_ACTIVATION'; row.status='PUBLISHED_INACTIVE'; row.data=data; row.updatedBy=new mongoose.Types.ObjectId(req.user!.id); await row.save();
    await audit(req,'HOSTEL_LISTING_PUBLISHED_INACTIVE',listingModule,row.id,{approvedFee:data.approvedFee,session:data.session});
    await sendRoleNotice('REGISTERED_STUDENT','Hostel accommodation published',`${data.name} is now visible with the Registrar-approved price ₦${Number(data.approvedFee).toLocaleString()}. Booking is not open yet.`,`hostel-published:${row.id}`);
    res.json({listing:row,message:'Hostel and approved price are now visible to students. Booking remains disabled until you activate it.'});
  }catch(e){next(e);}
});
router.patch('/listings/:id/booking', allowRoles('HOSTEL_ADMIN'), async (req,res,next) => {
  try {
    const b=z.object({active:z.boolean()}).parse(req.body);
    const row=await RecordModel.findOne({_id:req.params.id,module:listingModule,status:{$in:['PUBLISHED_INACTIVE','PUBLISHED_ACTIVE','DEACTIVATED']}});
    if(!row) return res.status(404).json({message:'Published hostel listing not found.'});
    const data:any=row.data;
    if(b.active && row.status==='DEACTIVATED') return res.status(409).json({message:'Reactivate the listing before opening booking.'});
    data.bookingActive=b.active; data.bookingActivatedAt=b.active?new Date():null; data.bookingActivatedBy=b.active?req.user!.id:null; row.status=b.active?'PUBLISHED_ACTIVE':(row.status==='DEACTIVATED'?'DEACTIVATED':'PUBLISHED_INACTIVE'); row.data=data; row.updatedBy=new mongoose.Types.ObjectId(req.user!.id); await row.save();
    await audit(req,b.active?'HOSTEL_BOOKING_ACTIVATED':'HOSTEL_BOOKING_DEACTIVATED',listingModule,row.id,{active:b.active});
    res.json({listing:row,message:b.active?'Booking is now open for this published hostel.':'Booking is now disabled. The published listing and images remain visible to students.'});
  }catch(e){next(e);}
});
router.patch('/listings/:id/reactivate', allowRoles('HOSTEL_ADMIN'), async (req,res,next) => {
  try {
    const b=z.object({reason:z.string().trim().min(5).max(1000)}).parse(req.body);
    const row=await RecordModel.findOne({_id:req.params.id,module:listingModule,status:'DEACTIVATED'});
    if(!row) return res.status(404).json({message:'Deactivated hostel listing not found.'});
    const data:any=row.data; data.bookingActive=false; data.reactivatedAt=new Date(); data.reactivatedBy=req.user!.id; data.reactivationReason=b.reason; row.status='PUBLISHED_INACTIVE'; row.data=data; row.updatedBy=new mongoose.Types.ObjectId(req.user!.id); await row.save();
    await audit(req,'HOSTEL_LISTING_REACTIVATED_INACTIVE',listingModule,row.id,{reason:b.reason});
    res.json({listing:row,message:'Listing is visible again, but booking remains disabled until you explicitly activate it.'});
  }catch(e){next(e);}
});

router.patch('/listings/:id/deactivate', allowRoles('HOSTEL_ADMIN'), async (req,res,next) => {
  try {
    const b=z.object({reason:z.string().trim().min(5).max(1000)}).parse(req.body);
    const row=await RecordModel.findOne({_id:req.params.id,module:listingModule,status:{$in:['PUBLISHED_INACTIVE','PUBLISHED_ACTIVE','DEACTIVATED']}});
    if(!row) return res.status(404).json({message:'Published hostel listing not found.'});
    const data:any=row.data; data.bookingActive=false; data.deactivatedAt=new Date(); data.deactivatedBy=req.user!.id; data.deactivationReason=b.reason; row.status='DEACTIVATED'; row.data=data; row.updatedBy=new mongoose.Types.ObjectId(req.user!.id); await row.save();
    await audit(req,'HOSTEL_LISTING_DEACTIVATED',listingModule,row.id,{reason:b.reason});
    res.json({listing:row,message:'Listing deactivated. Its description, photos, and existing allocations remain preserved; booking is disabled.'});
  }catch(e){next(e);}
});

// Student reserves a bed only after the Hostel Administrator activates booking. The listing document is updated atomically so simultaneous requests cannot exceed capacity.
router.post('/listings/:id/reservations', allowRoles(...studentRoles), async (req,res,next) => {
  try {
    const b=z.object({session:z.string().trim().min(4).max(30)}).parse(req.body);
    const student=await User.findById(req.user!.id).select('role matricNumber admissionSession status');
    if(!student || !student.matricNumber || student.role!=='REGISTERED_STUDENT') return res.status(403).json({message:'Only active registered students with a matriculation number can reserve hostel accommodation.'});
    if(student.admissionSession && student.admissionSession!==b.session) return res.status(403).json({message:'The requested session does not match your student record.'});
    const barred=await RecordModel.findOne({module:'hostel-violation',ownerId:req.user!.id,'data.session':b.session,'data.blocksApplication':true,'data.bedReleaseSession':b.session}).lean();
    if(barred) return res.status(403).json({message:'Your hostel application is blocked for this academic session due to a recorded hostel violation.'});
    const now=new Date();
    const priorListings=await RecordModel.find({module:listingModule,'data.reservations':{$elemMatch:{studentId:req.user!.id,session:b.session,$or:[{status:'CONFIRMED'},{status:'RESERVED',expiresAt:{$gt:now.toISOString()}}]}}}).select('_id data.name').limit(1).lean();
    if(priorListings.length) return res.status(409).json({message:'You already have a confirmed allocation or active reservation for this session. Only one active hostel reservation is allowed.'});
    const listing=await RecordModel.findOne({_id:req.params.id,module:listingModule,status:'PUBLISHED_ACTIVE'}).lean() as any;
    if(!listing || listing.data?.bookingActive!==true) return res.status(409).json({message:'This hostel is visible, but the Hostel Administrator has not activated booking yet.'});
    if(String(listing.data.session)!==b.session) return res.status(409).json({message:'This hostel is not accepting reservations for the selected session.'});
    const existing=activeReservations(listing.data,now).find((r:any)=>String(r.studentId)===req.user!.id);
    if(existing) return res.status(409).json({message:'You already have an active temporary reservation for this hostel.',reservation:existing});
    const reservationId=uuidv4(); const expiresAt=new Date(now.getTime()+reservationMinutes*60*1000); const reference=`HOSTEL-${uuidv4()}`; const amountKobo=Math.round(Number(listing.data.approvedFee)*100);
    if(!Number.isFinite(amountKobo)||amountKobo<1) return res.status(409).json({message:'This hostel does not have a valid Registrar-approved fee.'});
    // A unique per-student/session lock prevents parallel requests to different hostels from reserving two beds.
    const lockReference=`${req.user!.id}:${b.session}`;
    await RecordModel.findOneAndUpdate({module:'hostel-reservation-lock',reference:lockReference,status:'RESERVED','data.expiresAt':{$lte:now.toISOString()}},{$set:{status:'EXPIRED','updatedBy':req.user!.id}},{new:true});
    await RecordModel.deleteOne({module:'hostel-reservation-lock',reference:lockReference,status:'EXPIRED'});
    let lock:any;
    try { lock=await RecordModel.create({module:'hostel-reservation-lock',title:`Hostel reservation lock ${b.session}`,status:'RESERVED',reference:lockReference,ownerId:req.user!.id,createdBy:req.user!.id,updatedBy:req.user!.id,data:{studentId:req.user!.id,session:b.session,hostelId:String(listing._id),reservationId,expiresAt:expiresAt.toISOString(),paymentReference:reference}}); }
    catch(error:any) { if(error?.code===11000) return res.status(409).json({message:'You already have an active reservation or confirmed hostel allocation for this session.'}); throw error; }
    // initialize payment only after atomic reservation; roll the reservation back if Paystack cannot initialize.
    const reservationRows={ $ifNull:['$data.reservations',[]] };
    const occupyingCount={ $size:{ $filter:{ input:reservationRows, as:'r', cond:{ $or:[
      { $in:['$$r.status',['CONFIRMED','REVOKED_FOR_VIOLATION']] },
      { $and:[ { $eq:['$$r.status','RESERVED'] }, { $gt:[ { $dateFromString:{ dateString:'$$r.expiresAt', onError:'1970-01-01T00:00:00.000Z' } }, now ] } ] }
    ] } } } };
    const sameStudentActiveCount={ $size:{ $filter:{ input:reservationRows, as:'r', cond:{ $and:[
      { $eq:['$$r.studentId',req.user!.id] },
      { $or:[ { $eq:['$$r.status','CONFIRMED'] }, { $and:[ { $eq:['$$r.status','RESERVED'] }, { $gt:[ { $dateFromString:{ dateString:'$$r.expiresAt', onError:'1970-01-01T00:00:00.000Z' } }, now ] } ] } ] }
    ] } } } };
    const reservationGuard:any={_id:listing._id,module:listingModule,status:'PUBLISHED_ACTIVE','data.bookingActive':true,$expr:{ $and:[
      { $lt:[occupyingCount,{ $ifNull:['$data.totalBeds',0] }] },
      { $eq:[sameStudentActiveCount,0] }
    ] }};
    const reserved=await RecordModel.findOneAndUpdate(reservationGuard,{$push:{'data.reservations':{reservationId,studentId:req.user!.id,session:b.session,status:'RESERVED',createdAt:now,expiresAt:expiresAt.toISOString(),paymentReference:reference,amountNaira:amountKobo/100}}},{new:true});
    if(!reserved) { await RecordModel.updateOne({_id:lock._id},{$set:{status:'EXPIRED','updatedBy':req.user!.id}}); return res.status(409).json({message:'No bed is available, booking was closed, or you already hold an active reservation. Please refresh the listing.'}); }
    try {
      const payment=await initializePaystackPayment(req.user!.email,amountKobo,reference,{kind:'hostel-accommodation',hostelId:String(listing._id),reservationId,studentId:req.user!.id,session:b.session},`${env.clientOrigin.replace(/\/$/,'')}/accommodation?hostelReservation=${encodeURIComponent(reservationId)}&hostelId=${encodeURIComponent(String(listing._id))}`);
      await audit(req,'HOSTEL_BED_RESERVED','hostel-listing',String(listing._id),{reservationId,session:b.session,expiresAt,amountNaira:amountKobo/100});
      res.status(201).json({reservation:{reservationId,expiresAt,amountNaira:amountKobo/100,reference},payment,message:'Bed temporarily reserved for 60 minutes. Complete payment before the countdown expires.'});
    } catch(error) {
      await RecordModel.updateOne({_id:listing._id,module:listingModule},{$pull:{'data.reservations':{reservationId}}}); await RecordModel.updateOne({_id:lock._id},{$set:{status:'EXPIRED','updatedBy':req.user!.id}}); throw error;
    }
  }catch(e){next(e);}
});

router.post('/listings/:id/reservations/:reservationId/verify-payment', allowRoles(...studentRoles), async (req,res,next) => {
  try {
    const b=z.object({reference:z.string().trim().min(8).max(120)}).parse(req.body);
    const row=await RecordModel.findOne({_id:req.params.id,module:listingModule,status:'PUBLISHED_ACTIVE'});
    if(!row) return res.status(404).json({message:'Hostel listing not found or booking is closed.'});
    const data:any=row.data; const reservation=(data.reservations||[]).find((r:any)=>r.reservationId===req.params.reservationId&&String(r.studentId)===req.user!.id);
    if(!reservation) return res.status(404).json({message:'Reservation not found for your account.'});
    if(reservation.status==='CONFIRMED') return res.json({message:'Accommodation payment is already verified and allocation confirmed.',reservation});
    if(reservation.status!=='RESERVED'||new Date(reservation.expiresAt).getTime()<=Date.now()) return res.status(409).json({message:'The 60-minute reservation has expired. Please make a new reservation if a bed is still available.'});
    if(reservation.paymentReference!==b.reference) return res.status(400).json({message:'Payment reference does not match this reservation.'});
    const expectedKobo=Math.round(Number(data.approvedFee)*100); const verified=await verifyPaystackPayment(b.reference);
    if(verified.reference!==b.reference||verified.status!=='success'||verified.currency!=='NGN'||verified.amount!==expectedKobo) return res.status(409).json({message:'Paystack amount, currency, or reference does not match the Registrar-approved hostel fee.'});
    const now=new Date();
    const updated=await RecordModel.findOneAndUpdate({_id:row._id,module:listingModule,status:'PUBLISHED_ACTIVE','data.bookingActive':true,'data.reservations':{$elemMatch:{reservationId:req.params.reservationId,studentId:req.user!.id,status:'RESERVED',paymentReference:b.reference,expiresAt:{$gt:now.toISOString()}}}},{$set:{'data.reservations.$.status':'CONFIRMED','data.reservations.$.verifiedAt':now,'data.reservations.$.verifiedAmountKobo':verified.amount,'data.reservations.$.currency':verified.currency,'data.reservations.$.verificationSource':'PAYSTACK_SERVER_API','data.reservations.$.confirmedAt':now}},{new:true});
    if(!updated) return res.status(409).json({message:'Reservation expired or changed while payment was being verified. Contact Bursary if Paystack charged you.'});
    await RecordModel.updateOne({module:'hostel-reservation-lock',reference:`${req.user!.id}:${reservation.session}`,status:'RESERVED','data.reservationId':req.params.reservationId},{$set:{status:'CONFIRMED','data.confirmedAt':now,'data.paymentReference':b.reference,updatedBy:req.user!.id}});
    await audit(req,'HOSTEL_PAYMENT_VERIFIED_ALLOCATION_CONFIRMED','hostel-listing',String(row._id),{reservationId:req.params.reservationId,reference:b.reference,amountKobo:verified.amount,currency:verified.currency});
    await notify(req.user!.id,'Hostel allocation confirmed',`Your payment for ${data.name} was verified and your bed allocation is confirmed for ${reservation.session}.`);
    await queueEmailUserIfEnabled(req.user!.id,`hostel-allocation-confirmed:${req.params.reservationId}`,'Hostel allocation confirmed',`Your payment for ${data.name} was verified and your bed allocation is confirmed for ${reservation.session}.`);
    await notify(String(row.ownerId),'New hostel allocation confirmed',`A student has completed payment and confirmed a bed at ${data.name} for ${reservation.session}.`);
    res.json({message:'Payment verified with Paystack. Your hostel allocation is confirmed.',reservation:(updated.data as any).reservations.find((r:any)=>r.reservationId===req.params.reservationId)});
  }catch(e){next(e);}
});

router.post('/listings/:id/violations', allowRoles('HOSTEL_ADMIN'), async (req,res,next) => {
  try {
    const b=z.object({studentId:z.string().min(1),session:z.string().trim().min(4).max(30),details:z.string().trim().min(10).max(2000)}).parse(req.body);
    const student=await User.findById(b.studentId).select('_id fullName role'); if(!student||!studentRoles.some(role=>role===student.role)) return res.status(404).json({message:'Registered student not found.'});
    const listing=await RecordModel.findOne({_id:req.params.id,module:listingModule}); if(!listing) return res.status(404).json({message:'Hostel not found.'});
    const violation=await RecordModel.create({module:'hostel-violation',title:`Hostel violation — ${student.fullName}`,status:'RECORDED',reference:`HOSTEL-VIOLATION:${b.session}:${uuidv4()}`,ownerId:student._id,createdBy:req.user!.id,updatedBy:req.user!.id,data:{studentId:String(student._id),studentName:student.fullName,hostelId:String(listing._id),session:b.session,details:b.details,blocksApplication:true,bedReleaseSession:b.session,recordedAt:new Date(),recordedBy:req.user!.id}});
    // A confirmed bed is revoked but remains unavailable until the next academic session.
    const data:any=listing.data; const revoked=(data.reservations||[]).filter((r:any)=>String(r.studentId)===String(student._id)&&r.session===b.session&&r.status==='CONFIRMED');
    for(const r of revoked){r.status='REVOKED_FOR_VIOLATION';r.revokedAt=new Date();r.bedReleaseSession=b.session;}
    data.reservations=data.reservations||[]; data.violationHistory=[...(data.violationHistory||[]),{violationId:String(violation._id),studentId:String(student._id),session:b.session,details:b.details,bedReleaseSession:b.session,revokedAt:new Date()}]; listing.data=data; listing.updatedBy=new mongoose.Types.ObjectId(req.user!.id); await listing.save();
    await audit(req,'HOSTEL_VIOLATION_RECORDED',listingModule,String(listing._id),{studentId:String(student._id),session:b.session,violationId:String(violation._id)});
    await notify(String(student._id),'Hostel restriction recorded',`A hostel violation was recorded for ${b.session}. Your hostel application access is blocked for this session. Contact the Hostel Administrator for the official record and review route.`);
    res.status(201).json({violation,message:'Violation recorded. Student applications are blocked for the current session and the revoked bed remains held until the next session.'});
  }catch(e){next(e);}
});

export default router;

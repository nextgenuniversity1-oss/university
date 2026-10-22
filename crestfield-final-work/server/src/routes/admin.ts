import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { authenticate, allowRoles } from '../middleware/auth.js';
import { User } from '../models/User.js';
import { AuditLog } from '../models/AuditLog.js';
import { SystemSetting } from '../models/SystemSetting.js';
import { audit } from '../services/audit.js';
import { getEmailConfigurationStatus, verifyEmailConfiguration } from '../services/email.js';
import { env } from '../config/env.js';

const router = Router();
router.use(authenticate, allowRoles('SUPER_ADMIN'));
router.get('/overview', async (_req,res,next) => {
  try {
    const [totalUsers,activeUsers,suspendedUsers,staffUsers,applicants,recentAudit,roleCounts,latestEvents] = await Promise.all([
      User.countDocuments(), User.countDocuments({status:'ACTIVE'}), User.countDocuments({status:'SUSPENDED'}),
      User.countDocuments({role:{$in:['REGISTRAR','BURSARY','HOSTEL_ADMIN','ADMISSION_OFFICER','LECTURER','LECTURER_HOD']}}),
      User.countDocuments({role:{$in:['APPLICANT','ADMITTED_STUDENT','REGISTERED_STUDENT','GRADUATED_STUDENT','STUDENT']}}),
      AuditLog.countDocuments({createdAt:{$gte:new Date(Date.now()-24*60*60*1000)}}),
      User.aggregate([{$group:{_id:'$role',count:{$sum:1}}},{$sort:{count:-1}}]),
      AuditLog.find().sort({createdAt:-1}).limit(8).select('actorEmail action resource resourceId ipAddress createdAt').lean()
    ]);
    const dbState = mongoose.connection.readyState;
    res.json({stats:{totalUsers,activeUsers,suspendedUsers,staffUsers,applicants,auditEvents24h:recentAudit,database:dbState===1?'connected':'disconnected',api:'online'},roleCounts:roleCounts.map(x=>({role:x._id,count:x.count})),latestEvents});
  } catch(e){next(e)}
});
const defaults = { universityName:'Crestfield University', academicSession:'', timezone:'Africa/Lagos', maintenanceMode:false, allowApplicantRegistration:true, supportEmail:'', applicationFeeEnabled:false, paymentProvider:'Paystack', notificationMode:'email' };
router.get('/settings', async (_req,res,next)=>{try{const row=await SystemSetting.findOne({key:'general'}).lean();res.json({settings:{...defaults,...(row?.value as object||{})}})}catch(e){next(e)}});
router.put('/settings', async (req,res,next)=>{try{
 const body=z.object({universityName:z.string().trim().min(2).max(120),academicSession:z.string().trim().max(30),timezone:z.string().trim().min(3).max(80),maintenanceMode:z.boolean(),allowApplicantRegistration:z.boolean(),supportEmail:z.union([z.string().email(),z.literal('')]),applicationFeeEnabled:z.boolean(),paymentProvider:z.enum(['Paystack']),notificationMode:z.enum(['email','in_app'])}).parse(req.body);
 const row=await SystemSetting.findOneAndUpdate({key:'general'},{$set:{value:body,updatedBy:req.user!.id}},{upsert:true,new:true,setDefaultsOnInsert:true});
 await audit(req,'SYSTEM_SETTINGS_UPDATED','SystemSetting',row.id,{changedFields:Object.keys(body)});
 res.json({message:'System settings saved.',settings:body});
 }catch(e){next(e)}});
router.get('/health', async (_req,res)=>{
 const email = getEmailConfigurationStatus();
 const configured={jwtSecret:!!process.env.JWT_SECRET,mongoUri:!!process.env.MONGODB_URI,cloudinary:!!(process.env.CLOUDINARY_CLOUD_NAME&&process.env.CLOUDINARY_API_KEY&&process.env.CLOUDINARY_API_SECRET),email:email.status==='configured',paystack:!!process.env.PAYSTACK_SECRET_KEY};
 res.json({checkedAt:new Date().toISOString(),api:'online',database:mongoose.connection.readyState===1?'connected':'disconnected',integrations:configured,email,notes:'Configuration presence does not prove provider authentication or recipient delivery. SMTP credentials are never returned.'});
});
router.post('/email/diagnostics', async (_req,res) => {
 const diagnostics = await verifyEmailConfiguration();
 res.status(diagnostics.verified || diagnostics.status === 'missing' || diagnostics.status === 'invalid' ? 200 : 503).json({checkedAt:new Date().toISOString(),...diagnostics});
});
export default router;

import { Router } from 'express';
import { z } from 'zod';
import { authenticate, allowRoles } from '../middleware/auth.js';
import { AuditLog } from '../models/AuditLog.js';
const router = Router();
router.get('/', authenticate, allowRoles('SUPER_ADMIN','REGISTRAR'), async (req,res,next) => {
 try {
  const query=z.object({q:z.string().trim().max(120).optional(),action:z.string().trim().max(100).optional(),from:z.string().optional(),to:z.string().optional(),page:z.coerce.number().int().min(1).default(1),limit:z.coerce.number().int().min(10).max(100).default(50)}).parse(req.query);
  const filter:any={};
  if(query.action) filter.action=query.action;
  if(query.from || query.to){ filter.createdAt={}; if(query.from){const d=new Date(query.from); if(Number.isNaN(d.getTime())) return res.status(400).json({message:'Invalid start date.'}); filter.createdAt.$gte=d;} if(query.to){const d=new Date(query.to); if(Number.isNaN(d.getTime())) return res.status(400).json({message:'Invalid end date.'}); d.setHours(23,59,59,999); filter.createdAt.$lte=d;} }
  if(query.q) filter.$or=[{actorEmail:{$regex:query.q,$options:'i'}},{action:{$regex:query.q,$options:'i'}},{resource:{$regex:query.q,$options:'i'}},{resourceId:{$regex:query.q,$options:'i'}}];
  const [logs,total,actions]=await Promise.all([AuditLog.find(filter).sort({createdAt:-1}).skip((query.page-1)*query.limit).limit(query.limit).lean(),AuditLog.countDocuments(filter),AuditLog.distinct('action')]);
  res.json({logs,total,page:query.page,limit:query.limit,pages:Math.ceil(total/query.limit),actions:actions.sort()});
 }catch(e){next(e)}
});
export default router;

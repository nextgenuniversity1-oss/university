import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { Notification } from '../models/Notification.js';
const router = Router();
router.use(authenticate);
router.get('/', async (req,res,next) => { try { res.json({ notifications: await Notification.find({ userId: req.user!.id }).sort({ createdAt: -1 }).limit(100) }); } catch(e) { next(e); } });
router.patch('/:id/read', async (req,res,next) => { try { const n = await Notification.findOneAndUpdate({ _id:req.params.id, userId:req.user!.id }, { readAt:new Date() }, {new:true}); if(!n) return res.status(404).json({message:'Notification not found.'}); res.json({notification:n}); } catch(e) { next(e); } });
export default router;

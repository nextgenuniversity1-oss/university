import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { Application } from '../models/Application.js';
import { RecordModel } from '../models/Record.js';
import { Notification } from '../models/Notification.js';
const router = Router();
router.get('/', authenticate, async (req, res, next) => {
 try {
  const role = req.user!.role;
  const applicationFilter = ['SUPER_ADMIN','REGISTRAR','ADMISSION_OFFICER'].includes(role) ? {} : { applicantId: req.user!.id };
  const [applications, pendingApplications, records, notifications] = await Promise.all([
    Application.countDocuments(applicationFilter),
    Application.countDocuments({ ...applicationFilter, status: { $in: ['SUBMITTED','UNDER_REVIEW'] } }),
    RecordModel.countDocuments(['STUDENT','ADMITTED_STUDENT','REGISTERED_STUDENT','GRADUATED_STUDENT','APPLICANT'].includes(role) ? { ownerId: req.user!.id } : {}),
    Notification.countDocuments({ userId: req.user!.id, readAt: { $exists: false } })
  ]);
  res.json({ stats: [{ label: 'Applications', value: applications }, { label: 'Awaiting review', value: pendingApplications }, { label: 'Records', value: records }, { label: 'Unread notifications', value: notifications }] });
 } catch(e) { next(e); }
});
export default router;

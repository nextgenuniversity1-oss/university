import { Router } from 'express';
import { z } from 'zod';
import { RecordModel } from '../models/Record.js';
import { authenticate, allowRoles } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
const router = Router();
const studentRoles = ['STUDENT','ADMITTED_STUDENT','REGISTERED_STUDENT','GRADUATED_STUDENT'];
const teachingRoles = ['LECTURER','LECTURER_HOD']; // LECTURER_HOD is retained for legacy accounts during migration.
const moduleRoles: Record<string, string[]> = {
  // Super Admin is deliberately excluded from institutional records; technical administration is served by /api/admin and /api/users.
  recruitment: ['REGISTRAR',...teachingRoles],
  academics: ['REGISTRAR',...teachingRoles,...studentRoles],
  finance: ['BURSARY','REGISTRAR',...studentRoles],
  accommodation: ['HOSTEL_ADMIN','REGISTRAR','REGISTERED_STUDENT','STUDENT'],
  graduation: ['REGISTRAR','BURSARY',...teachingRoles,...studentRoles],
  communications: ['REGISTRAR','ADMISSION_OFFICER','BURSARY','HOSTEL_ADMIN',...teachingRoles,...studentRoles,'APPLICANT'],
  reports: ['REGISTRAR','BURSARY','ADMISSION_OFFICER','HOSTEL_ADMIN',...teachingRoles],
  structure: ['REGISTRAR'],
  users: [],
  workflows: ['REGISTRAR'],
  'student-workflow': ['REGISTRAR','ADMITTED_STUDENT','REGISTERED_STUDENT','GRADUATED_STUDENT','STUDENT'],
  'lecturer-workflow': ['REGISTRAR','LECTURER','LECTURER_HOD'],
  'hostel-workflow': ['REGISTRAR','HOSTEL_ADMIN'],
  'system-engine-evaluation': ['REGISTRAR','LECTURER_HOD'],
};
router.use(authenticate);
router.get('/:module', async (req, res, next) => {
  try {
    const module = String(req.params.module);
    if (!moduleRoles[module]?.includes(req.user!.role)) return res.status(403).json({ message: 'You do not have permission to view this module.' });
    const query: Record<string, unknown> = { module };
    if ([...studentRoles,'APPLICANT'].includes(req.user!.role)) query.ownerId = req.user!.id;
    const records = await RecordModel.find(query).sort({ createdAt: -1 }).limit(250);
    res.json({ records });
  } catch (e) { next(e); }
});
router.post('/:module', async (req, res, next) => {
  try {
    const module = String(req.params.module);
    const isStudent=[...studentRoles,'APPLICANT'].includes(req.user!.role);
    if (!moduleRoles[module]?.includes(req.user!.role) || isStudent && !['accommodation','communications'].includes(module))
      return res.status(403).json({ message: 'You do not have permission to create records in this module. Student academic, finance, and graduation requests must use the dedicated student workflow so they cannot forge official outcomes.' });
    if (isStudent && req.body?.status && !['SUBMITTED','PENDING_REVIEW'].includes(String(req.body.status))) return res.status(400).json({message:'Student-created records cannot begin in an approved or finalized state.'});
    if (module === 'graduation') return res.status(403).json({message:'Graduation and clearance records must be created through the dedicated clearance workflow so the student identity, submitting unit, and approval history are validated.'});
    if (req.user!.role === 'REGISTRAR' && ['recruitment','academics','workflows','graduation'].includes(module)) {
      return res.status(403).json({ message: 'Canonical recruitment, result, and workflow records must be created by their owning workflow, not manually by Registrar.' });
    }
    const b = z.object({ title: z.string().min(2).max(180), status: z.string().max(40).optional(), reference: z.string().max(100).optional(), data: z.record(z.string(), z.unknown()).optional() }).parse(req.body);
    if (b.status && ['APPROVED','PUBLISHED','COMPLETED','GRADUATED','ACCEPTED'].includes(b.status)) return res.status(400).json({message:'Official outcomes cannot be created directly. Use the owning workflow and audited decision endpoint.'});
    if (module==='graduation' && ['BURSARY','LECTURER','LECTURER_HOD','SUPER_ADMIN'].includes(req.user!.role) && !b.data?.clearanceType) return res.status(400).json({message:'Graduation-module records must identify their clearanceType and studentId.'});
    const record = await RecordModel.create({ module, ...b, status: isStudent ? (b.status || 'SUBMITTED') : (b.status || 'DRAFT'), ownerId: req.user!.id, createdBy: req.user!.id, updatedBy: req.user!.id });
    await audit(req, 'RECORD_CREATED', module, record.id, { title: record.title });
    res.status(201).json({ record });
  } catch (e) { next(e); }
});
router.patch('/:module/:id', async (req, res, next) => {
  try {
    const module = String(req.params.module);
    if (!moduleRoles[module]?.includes(req.user!.role) || [...studentRoles,'APPLICANT'].includes(req.user!.role)) return res.status(403).json({ message: 'You do not have permission to update this record.' });
    // Registrar decisions on canonical recruitment, academic-result, and workflow records must
    // pass through /api/registrar/records/:id/decision so the decision reason and audit trail
    // are written to both the Registrar record and the owning workflow. Block generic edits.
    if (req.user!.role === 'REGISTRAR' && ['recruitment','academics','workflows'].includes(module)) {
      return res.status(403).json({ message: 'Registrar cannot directly edit canonical recruitment, result, or workflow records. Use the audited Registrar decision workflow for authorized final decisions.' });
    }
    const b = z.object({ title: z.string().min(2).max(180).optional(), status: z.string().max(40).optional(), data: z.record(z.string(), z.unknown()).optional() }).parse(req.body);
    if (['APPROVED','PUBLISHED','COMPLETED','GRADUATED','ACCEPTED'].includes(String(b.status||''))) return res.status(400).json({message:'Official outcomes cannot be set through generic record editing. Use the owning audited decision workflow.'});
    if (['student-workflow','graduation','academics'].includes(module)) return res.status(403).json({message:'Canonical student workflow, academic, and clearance records cannot be edited through the generic record endpoint.'});
    const record = await RecordModel.findOneAndUpdate({ _id: req.params.id, module }, { ...b, updatedBy: req.user!.id }, { new: true, runValidators: true });
    if (!record) return res.status(404).json({ message: 'Record not found.' });
    await audit(req, 'RECORD_UPDATED', module, record.id, b);
    res.json({ record });
  } catch (e) { next(e); }
});
export default router;

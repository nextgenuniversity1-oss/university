import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { authenticate, allowRoles } from '../middleware/auth.js';
import { RecordModel } from '../models/Record.js';
import { Application } from '../models/Application.js';
import { User } from '../models/User.js';
import { SystemSetting } from '../models/SystemSetting.js';
import { audit } from '../services/audit.js';

const router = Router();
const categories = ['faculty','department','programme','course','academic-calendar','academic-policy','hod-appointment','lecturer-recruitment-decision','result-approval','deferment-decision','student-record','announcement','report'] as const;
const statuses = ['DRAFT','ACTIVE','INACTIVE','PENDING_REVIEW','RECOMMENDED','APPROVED','REJECTED','PUBLISHED','REVOKED','COMPLETED'] as const;
const base = { module: 'registrar' };
router.use(authenticate, allowRoles('REGISTRAR'));

router.get('/overview', async (_req,res,next) => {
  try {
    const [total, applications, pendingRecords, staff, recent] = await Promise.all([
      RecordModel.countDocuments(base), Application.countDocuments({}),
      RecordModel.countDocuments({ ...base, status: { $in: ['PENDING_REVIEW','RECOMMENDED'] } }),
      User.countDocuments({ role: { $in: ['LECTURER','LECTURER_HOD'] }, status: 'ACTIVE' }),
      RecordModel.find(base).sort({ updatedAt: -1 }).limit(8).select('title status data.category updatedAt reference')
    ]);
    res.json({ stats: { totalInstitutionalRecords: total, applications, pendingRegistrarActions: pendingRecords, activeTeachingStaff: staff }, recent });
  } catch(e) { next(e); }
});

router.get('/records', async (req,res,next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const q = String(req.query.q || '').trim();
    const category = String(req.query.category || '');
    const status = String(req.query.status || '');
    const query: Record<string, unknown> = { ...base };
    if (category && (categories as readonly string[]).includes(category)) query['data.category'] = category;
    if (status && (statuses as readonly string[]).includes(status)) query.status = status;
    if (q) query.$or = [{ title: { $regex: q, $options: 'i' } }, { reference: { $regex: q, $options: 'i' } }, { 'data.department': { $regex: q, $options: 'i' } }, { 'data.studentName': { $regex: q, $options: 'i' } }];
    const [records,total] = await Promise.all([RecordModel.find(query).sort({updatedAt:-1}).skip((page-1)*limit).limit(limit), RecordModel.countDocuments(query)]);
    res.json({ records, total, page, limit, pages: Math.max(1,Math.ceil(total/limit)), categories, statuses });
  } catch(e) { next(e); }
});

const recordInput = z.object({ category: z.enum(categories), title: z.string().trim().min(2).max(180), reference: z.string().trim().max(100).optional(), status: z.enum(statuses).optional(), details: z.string().trim().max(5000).optional(), data: z.record(z.string(), z.unknown()).optional() });
router.post('/records', async (req,res,next) => {
  try {
    const b = recordInput.parse(req.body);
    const data = { ...(b.data || {}), category: b.category, details: b.details || b.data?.details || '', decisionHistory: [] };
    // Prevent creation of pre-approved institutional decisions. Every official outcome must pass the decision endpoint.
    if (b.status && b.status !== 'DRAFT') return res.status(400).json({ message: 'New Registrar records must begin as DRAFT. Use the audited decision workflow for status changes.' });
    if (b.reference && await RecordModel.exists({ module: 'registrar', reference: b.reference })) return res.status(409).json({ message: 'That institutional reference is already in use.' });
    const record = await RecordModel.create({ module:'registrar', title:b.title, reference:b.reference, status:'DRAFT', data, createdBy:req.user!.id, updatedBy:req.user!.id });
    await audit(req,'REGISTRAR_RECORD_CREATED',b.category,record.id,{ title:b.title, reference:b.reference });
    res.status(201).json({ record });
  } catch(e) { next(e); }
});

router.patch('/records/:id', async (req,res,next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({message:'Invalid record identifier.'});
    const b = z.object({ title:z.string().trim().min(2).max(180).optional(), reference:z.string().trim().max(100).optional(), details:z.string().trim().max(5000).optional(), data:z.record(z.string(),z.unknown()).optional(), status:z.enum(statuses).optional() }).parse(req.body);
    if (b.status !== undefined) return res.status(400).json({ message: 'Status changes must use the submit or audited decision workflow.' });
    const existing = await RecordModel.findOne({ _id:req.params.id, module:'registrar' });
    if (!existing) return res.status(404).json({message:'Registrar record not found.'});
    // Official outcomes are immutable through ordinary edits; use the decision endpoint to record a correction/revocation trail.
    if (['APPROVED','REJECTED','PUBLISHED','REVOKED','COMPLETED'].includes(existing.status)) return res.status(409).json({message:'Finalized records are immutable. Create a new version/correction record and reference the original; do not overwrite the official decision history.'});
    if (b.reference !== undefined && b.reference !== existing.reference && b.reference && await RecordModel.exists({ module: 'registrar', reference: b.reference, _id: { $ne: existing._id } })) return res.status(409).json({ message: 'That institutional reference is already in use.' });
    if (b.title !== undefined) existing.title = b.title;
    if (b.reference !== undefined) existing.reference = b.reference;
    existing.data = { ...(existing.data as Record<string,unknown>), ...(b.data || {}), ...(b.details !== undefined ? {details:b.details}: {}) };
    existing.updatedBy = new mongoose.Types.ObjectId(req.user!.id);
    await existing.save();
    await audit(req,'REGISTRAR_RECORD_UPDATED',String((existing.data as any).category || 'record'),existing.id,b);
    res.json({record:existing});
  } catch(e) { next(e); }
});


router.post('/records/:id/submit', async (req,res,next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({message:'Invalid record identifier.'});
    const record = await RecordModel.findOne({ _id:req.params.id, module:'registrar' });
    if (!record) return res.status(404).json({message:'Registrar record not found.'});
    if (record.status !== 'DRAFT') return res.status(409).json({message:`Only draft records can be submitted. Current status: ${record.status}.`});
    const category = String((record.data as any)?.category || '');
    if (!['lecturer-recruitment-decision','result-approval','deferment-decision','student-record','report'].includes(category)) return res.status(400).json({message:'This category does not use the submission workflow.'});
    const details = String((record.data as any)?.details || '').trim();
    if (details.length < 5) return res.status(400).json({message:'Add supporting details before submission.'});
    const submissionData = (record.data || {}) as Record<string, any>;
    const requiredTargetModule = category === 'lecturer-recruitment-decision' ? 'recruitment' : category === 'result-approval' ? 'academics' : category === 'deferment-decision' ? 'workflows' : '';
    if (requiredTargetModule) {
      const linkedId = String(submissionData.linkedRecordId || '').trim();
      if (!mongoose.isValidObjectId(linkedId) || !await RecordModel.exists({ _id:linkedId, module:requiredTargetModule }))
        return res.status(400).json({ message:`Before submission, provide linkedRecordId for an existing canonical ${requiredTargetModule} record in the structured metadata.` });
    }
    record.status = 'PENDING_REVIEW';
    record.updatedBy = new mongoose.Types.ObjectId(req.user!.id);
    const data = (record.data || {}) as Record<string, any>;
    record.data = { ...data, submittedAt:new Date().toISOString(), submittedBy:req.user!.id, submissionPolicyVersion:'registrar-submission-v1' };
    await record.save();
    await audit(req,'REGISTRAR_RECORD_SUBMITTED',category,record.id,{ from:'DRAFT', to:'PENDING_REVIEW' });
    res.json({record,message:'Record submitted for formal decision.'});
  } catch(e) { next(e); }
});

const decisions: Record<string, { from:string[]; to:string[]; audit:string }> = {
  'hod-appointment': { from:['DRAFT','PENDING_REVIEW','ACTIVE','APPROVED'], to:['APPROVED','REVOKED'], audit:'REGISTRAR_HOD_APPOINTMENT_DECISION' },
  'lecturer-recruitment-decision': { from:['RECOMMENDED','PENDING_REVIEW'], to:['APPROVED','REJECTED'], audit:'REGISTRAR_LECTURER_RECRUITMENT_FINAL_DECISION' },
  'result-approval': { from:['PENDING_REVIEW','RECOMMENDED'], to:['APPROVED','REJECTED','PUBLISHED'], audit:'REGISTRAR_RESULT_FINAL_DECISION' },
  'deferment-decision': { from:['PENDING_REVIEW','RECOMMENDED'], to:['APPROVED','REJECTED'], audit:'REGISTRAR_DEFERMENT_FINAL_DECISION' },
  'academic-calendar': { from:['DRAFT','ACTIVE'], to:['APPROVED','PUBLISHED','INACTIVE'], audit:'REGISTRAR_CALENDAR_DECISION' },
  'academic-policy': { from:['DRAFT','ACTIVE'], to:['APPROVED','PUBLISHED','INACTIVE'], audit:'REGISTRAR_POLICY_DECISION' },
  'faculty': { from:['DRAFT','ACTIVE','INACTIVE'], to:['ACTIVE','INACTIVE'], audit:'REGISTRAR_FACULTY_STATUS' },
  'department': { from:['DRAFT','ACTIVE','INACTIVE'], to:['ACTIVE','INACTIVE'], audit:'REGISTRAR_DEPARTMENT_STATUS' },
  'programme': { from:['DRAFT','ACTIVE','INACTIVE'], to:['ACTIVE','INACTIVE'], audit:'REGISTRAR_PROGRAMME_STATUS' },
  'course': { from:['DRAFT','ACTIVE','INACTIVE'], to:['ACTIVE','INACTIVE'], audit:'REGISTRAR_COURSE_STATUS' },
  'student-record': { from:['DRAFT','PENDING_REVIEW','ACTIVE'], to:['APPROVED','REVOKED'], audit:'REGISTRAR_STUDENT_RECORD_DECISION' },
  'announcement': { from:['DRAFT','ACTIVE'], to:['APPROVED','PUBLISHED','INACTIVE'], audit:'REGISTRAR_ANNOUNCEMENT_DECISION' },
  'report': { from:['DRAFT','PENDING_REVIEW'], to:['APPROVED','COMPLETED'], audit:'REGISTRAR_REPORT_DECISION' }
};
router.post('/records/:id/decision', async (req,res,next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({message:'Invalid record identifier.'});
    const b = z.object({ outcome:z.string().min(2).max(40), reason:z.string().trim().min(5).max(2000) }).parse(req.body);
    const record = await RecordModel.findOne({ _id:req.params.id, module:'registrar' });
    if (!record) return res.status(404).json({message:'Registrar record not found.'});
    const category = String((record.data as any)?.category || '');
    const rule = decisions[category];
    if (!rule || !rule.to.includes(b.outcome)) return res.status(400).json({message:'This outcome is not permitted for this record category.'});
    if (!rule.from.includes(record.status)) return res.status(409).json({message:`Cannot make this decision while the record is ${record.status}.`});
    if (category === 'hod-appointment' && record.status === 'APPROVED' && b.outcome !== 'REVOKED') return res.status(409).json({message:'An approved HOD appointment can only be revoked, not approved again.'});

    // Cross-module decisions must point at the canonical operational record. This prevents a
    // Registrar decision from becoming an isolated note disconnected from the owning workflow.
    const linkedRecordId = String(((record.data || {}) as any).linkedRecordId || '').trim();
    let linkedRecord: any = null;
    const targetModule = category === 'lecturer-recruitment-decision' ? 'recruitment' :
      category === 'result-approval' ? 'academics' : category === 'deferment-decision' ? 'workflows' : '';
    if (targetModule && ['APPROVED','PUBLISHED','REJECTED'].includes(b.outcome)) {
      if (!linkedRecordId || !mongoose.isValidObjectId(linkedRecordId)) {
        return res.status(400).json({ message: `Add a valid linkedRecordId for the canonical ${targetModule} record before recording this final decision.` });
      }
      linkedRecord = await RecordModel.findOne({ _id: linkedRecordId, module: targetModule });
      if (!linkedRecord) return res.status(404).json({ message: `The linked ${targetModule} record was not found.` });
      const linkedData = (linkedRecord.data || {}) as Record<string, any>;
      if (category === 'lecturer-recruitment-decision' && !['PENDING_REVIEW','RECOMMENDED','PANEL_REVIEW','SHORTLISTED','OPEN'].includes(linkedRecord.status))
        return res.status(409).json({ message: `The linked recruitment record is ${linkedRecord.status} and cannot receive a final Registrar decision.` });
      if (category === 'lecturer-recruitment-decision' && linkedData.kind && !['lecturer-recruitment','recruitment-candidate','lecturer-vacancy'].includes(String(linkedData.kind)))
        return res.status(400).json({ message: 'The linked recruitment record is not a lecturer recruitment workflow record.' });
      if (category === 'result-approval' && !['SUBMITTED','UNDER_REVIEW','IN_PROGRESS','COMPLETED','PENDING_REVIEW','RECOMMENDED'].includes(linkedRecord.status))
        return res.status(409).json({ message: `The linked academic/result record is ${linkedRecord.status} and cannot receive a final result decision.` });
      if (category === 'deferment-decision' && !['REQUESTED','SUBMITTED','PENDING_REVIEW','UNDER_REVIEW','IN_REVIEW'].includes(linkedRecord.status))
        return res.status(409).json({ message: `The linked deferment request is ${linkedRecord.status} and cannot receive a final decision.` });
      // Guard against linking a result/deferment decision to an unrelated record.
      if (category === 'result-approval' && !['result','course-result','assessment-result'].includes(String(linkedData.kind || '')))
        return res.status(400).json({ message: 'The linked academics record must explicitly identify itself as kind=result, course-result, or assessment-result.' });
      if (category === 'deferment-decision' && !['deferment','deferment-request'].includes(String(linkedData.kind || '')))
        return res.status(400).json({ message: 'The linked workflows record must explicitly identify itself as kind=deferment or deferment-request.' });
    }
    const previousStatus = record.status;
    record.status = b.outcome;
    const priorData = (record.data || {}) as Record<string, any>;
    const decisionEntry = { outcome:b.outcome, reason:b.reason, decidedBy:req.user!.id, decidedByEmail:req.user!.email, decidedAt:new Date().toISOString(), previousStatus, policyVersion: 'registrar-decisions-v1' };
    const history = Array.isArray(priorData.decisionHistory) ? priorData.decisionHistory : (priorData.decision ? [priorData.decision] : []);
    record.data = { ...priorData, decision: decisionEntry, decisionHistory: [...history, decisionEntry] };
    // HOD is an appointment flag on an existing lecturer account, never a separate base identity.
    if (category === 'hod-appointment' && b.outcome === 'APPROVED') {
      const lecturerId = String(priorData.lecturerId || '');
      const lecturerEmail = String(priorData.lecturerEmail || '').trim().toLowerCase();
      if (!lecturerId && !lecturerEmail) return res.status(400).json({ message: 'HOD appointment metadata must include lecturerId or lecturerEmail before approval.' });
      const lecturerQuery = lecturerId && mongoose.isValidObjectId(lecturerId) ? { _id: lecturerId } : { email: lecturerEmail };
      const lecturer = await User.findOne({ ...lecturerQuery, role: { $in: ['LECTURER', 'LECTURER_HOD'] }, status: 'ACTIVE' });
      if (!lecturer) return res.status(409).json({ message: 'The appointment must reference an existing active lecturer account.' });
      const alreadyAppointed = await RecordModel.findOne({ module:'registrar', 'data.category':'hod-appointment', status:{ $in:['APPROVED','ACTIVE'] }, _id:{ $ne:record._id}, $or:[ { 'data.department': priorData.department }, { 'data.lecturerId': String(lecturer._id) }, { 'data.lecturerEmail': lecturer.email } ] });
      if (alreadyAppointed) return res.status(409).json({ message: 'An active HOD appointment already exists for this lecturer or department. Revoke the previous appointment before appointing a replacement.' });
      lecturer.hodScope = true; lecturer.role = 'LECTURER_HOD';
      if (priorData.department) { lecturer.department = String(priorData.department); lecturer.appointmentDepartment = String(priorData.department); }
      if (priorData.faculty) lecturer.faculty = String(priorData.faculty);
      await lecturer.save();
      (record.data as Record<string, any>).lecturerId = String(lecturer._id);
      (record.data as Record<string, any>).lecturerEmail = lecturer.email;
    }
    if (category === 'hod-appointment' && b.outcome === 'REVOKED') {
      const lecturerId = String(priorData.lecturerId || '');
      const lecturerEmail = String(priorData.lecturerEmail || '').trim().toLowerCase();
      const lecturerQuery = lecturerId && mongoose.isValidObjectId(lecturerId) ? { _id: lecturerId } : lecturerEmail ? { email: lecturerEmail } : null;
      if (lecturerQuery) { const lecturer = await User.findOne({ ...lecturerQuery, role: { $in: ['LECTURER', 'LECTURER_HOD'] } }); if (lecturer) { lecturer.hodScope = false; lecturer.role = 'LECTURER'; lecturer.appointmentDepartment = undefined; await lecturer.save(); } }
    }
    record.updatedBy = new mongoose.Types.ObjectId(req.user!.id);
    await record.save();

    // Apply the same authorized decision to the canonical workflow record, retaining a complete
    // trail there as well as on the Registrar's decision record.
    if (linkedRecord && targetModule) {
      const linkedData = (linkedRecord.data || {}) as Record<string, any>;
      const canonicalOutcome = b.outcome === 'REJECTED' ? 'REJECTED' :
        category === 'result-approval' ? b.outcome :
        category === 'lecturer-recruitment-decision' ? (b.outcome === 'APPROVED' ? 'APPROVED' : 'REJECTED') :
        (b.outcome === 'APPROVED' ? 'APPROVED' : 'REJECTED');
      const linkedHistory = Array.isArray(linkedData.registrarDecisionHistory) ? linkedData.registrarDecisionHistory : [];
      linkedRecord.status = canonicalOutcome;
      linkedRecord.data = { ...linkedData, registrarDecision: { outcome:b.outcome, canonicalOutcome, reason:b.reason, registrarRecordId:String(record._id), decidedBy:req.user!.id, decidedByEmail:req.user!.email, decidedAt:new Date().toISOString(), policyVersion:'registrar-cross-module-v1' }, registrarDecisionHistory:[...linkedHistory,{ outcome:b.outcome, canonicalOutcome, reason:b.reason, registrarRecordId:String(record._id), decidedBy:req.user!.id, decidedByEmail:req.user!.email, decidedAt:new Date().toISOString(), policyVersion:'registrar-cross-module-v1' }] };
      linkedRecord.updatedBy = new mongoose.Types.ObjectId(req.user!.id);
      await linkedRecord.save();
      await audit(req, 'REGISTRAR_CANONICAL_WORKFLOW_UPDATED', targetModule, linkedRecord.id, { registrarRecordId:record.id, category, outcome:b.outcome, canonicalOutcome });
    }
    await audit(req,rule.audit,category,record.id,{ outcome:b.outcome, reason:b.reason, previousStatus, linkedRecordId:linkedRecord ? String(linkedRecord._id) : undefined, linkedModule:targetModule || undefined });
    res.json({record, linkedRecord: linkedRecord || undefined, message:`Decision recorded: ${b.outcome}${linkedRecord ? ` and applied to the ${targetModule} workflow` : ''}.`});
  } catch(e) { next(e); }
});


const admissionConfigSchema = z.object({
  applicationOpen: z.boolean(),
  session: z.string().trim().min(4).max(30),
  applicationDeadline: z.string().datetime().nullable(),
  applicationFeeNaira: z.number().finite().min(0).max(10000000),
  screeningRulesVersion: z.string().trim().min(3).max(100),
  requiredDocuments: z.array(z.enum(['passport','birth_certificate','citizenship_certificate','signature','jamb_result','olevel_result'])).length(6).refine(items => new Set(items).size === 6, 'All six required documents must be included exactly once.'),
  programmeCapacities: z.record(z.string().trim().min(2).max(160), z.number().int().min(1).max(100000)),
  eligibilityRules: z.record(z.string(), z.unknown()),
});
router.get('/admissions-config', async (_req,res,next) => {
  try {
    const row = await SystemSetting.findOne({key:'admissions'}).lean();
    const config = row?.value ? { ...(row.value as any), requiredDocuments:['passport','birth_certificate','citizenship_certificate','signature','jamb_result','olevel_result'] } : null;
    res.json({config, configured:Boolean(row)});
  } catch(e) { next(e); }
});
router.put('/admissions-config', async (req,res,next) => {
  try {
    const b = admissionConfigSchema.parse(req.body);
    if (b.applicationDeadline && !Number.isFinite(new Date(b.applicationDeadline).getTime())) return res.status(400).json({message:'Application deadline is invalid.'});
    const previous = await SystemSetting.findOne({key:'admissions'}).lean();
    const config = {
      ...b,
      applicationDeadline:b.applicationDeadline,
      updatedAt:new Date().toISOString(),
      updatedBy:req.user!.id,
      policyVersion:b.screeningRulesVersion,
    };
    await SystemSetting.findOneAndUpdate({key:'admissions'},{$set:{value:config,updatedBy:req.user!.id}},{upsert:true,new:true,setDefaultsOnInsert:true});
    await audit(req,'ADMISSIONS_POLICY_CONFIGURED','SystemSetting','admissions',{session:b.session,applicationOpen:b.applicationOpen,applicationFeeNaira:b.applicationFeeNaira,screeningRulesVersion:b.screeningRulesVersion,requiredDocuments:b.requiredDocuments,programmeCapacityCount:Object.keys(b.programmeCapacities).length,previousPolicyVersion:(previous?.value as any)?.screeningRulesVersion||null});
    res.json({config,message:'Admission session, fee, deadline, document requirements, programme capacities and screening policy saved.'});
  } catch(e) { next(e); }
});


const matriculationConfigSchema = z.object({
  enabled: z.boolean(),
  departmentCodes: z.record(z.string().trim().min(2).max(120), z.string().trim().regex(/^[A-Za-z0-9]{2,12}$/)),
  sessions: z.record(z.string().trim().min(4).max(30), z.object({ enabled: z.boolean() })),
  nextSequence: z.record(z.string().trim().min(1).max(30), z.number().int().min(1).max(9999)).optional(),
});
router.get('/matriculation-config', async (_req,res,next) => {
  try { const row=await SystemSetting.findOne({key:'matriculation'}).lean(); res.json({config:row?.value||{enabled:false,departmentCodes:{},sessions:{},nextSequence:{}},configured:Boolean(row)}); }
  catch(e){next(e);}
});
router.put('/matriculation-config', async (req,res,next) => {
  try {
    const b=matriculationConfigSchema.parse(req.body);
    const previous=await SystemSetting.findOne({key:'matriculation'}).lean();
    const config={...b,nextSequence:b.nextSequence||((previous?.value as any)?.nextSequence)||{},updatedAt:new Date().toISOString(),updatedBy:req.user!.id};
    await SystemSetting.findOneAndUpdate({key:'matriculation'},{$set:{value:config,updatedBy:req.user!.id}},{upsert:true,new:true,setDefaultsOnInsert:true});
    await audit(req,'MATRICULATION_POLICY_CONFIGURED','SystemSetting','matriculation',{enabled:b.enabled,configuredDepartments:Object.keys(b.departmentCodes),enabledSessions:Object.keys(b.sessions).filter(k=>b.sessions[k].enabled),previouslyConfigured:Boolean(previous)});
    res.json({config,message:'Matriculation policy saved. Generation is available only to newly admitted students when the global switch and their exact admitted-session switch are enabled.'});
  }catch(e){next(e);}
});

// Registrar can immediately open/close matriculation generation for one admitted session.
router.post('/matriculation-config/session-toggle', async (req,res,next) => {
  try {
    const body=z.object({session:z.string().trim().min(4).max(30),enabled:z.boolean()}).parse(req.body);
    const setting=await SystemSetting.findOne({key:'matriculation'});
    const current=(setting?.value||{}) as any;
    if(!setting) return res.status(409).json({message:'Save department codes and the matriculation policy before enabling a session.'});
    const sessions={...(current.sessions||{}),[body.session]:{...(current.sessions?.[body.session]||{}),enabled:body.enabled}};
    const config={...current,enabled:true,sessions,updatedAt:new Date().toISOString(),updatedBy:req.user!.id};
    setting.value=config; setting.updatedBy=new mongoose.Types.ObjectId(req.user!.id); await setting.save();
    await audit(req,body.enabled?'MATRICULATION_GENERATION_ENABLED_FOR_SESSION':'MATRICULATION_GENERATION_DISABLED_FOR_SESSION','SystemSetting','matriculation',{session:body.session,enabled:body.enabled});
    res.json({config,message:body.enabled?`Newly admitted students from ${body.session} can now generate their matriculation number if their department code is configured.`:`Matriculation number generation is now disabled for ${body.session}.`});
  } catch(e){next(e);}
});



// Institutional student-academic rules are explicit, versioned configuration; the application
// never guesses grading scales, credit limits, registration windows, or progression thresholds.
const studentAcademicPolicySchema = z.object({
  policyVersion: z.string().trim().min(3).max(100),
  registrationWindows: z.record(z.string().trim().min(4).max(30), z.object({
    openAt: z.string().datetime().nullable(), closeAt: z.string().datetime().nullable(), enabled: z.boolean()
  })),
  creditLimitsByLevel: z.record(z.string().trim().min(1).max(30), z.object({ min: z.number().int().min(0).max(100), max: z.number().int().min(1).max(100) }).refine(v => v.min <= v.max, 'Minimum credits cannot exceed maximum credits.')),
  gradingScale: z.array(z.object({ minScore: z.number().min(0).max(100), maxScore: z.number().min(0).max(100), grade: z.string().trim().min(1).max(5), gradePoint: z.number().min(0).max(10) })).max(20),
  progressionRules: z.object({ minimumCGPA: z.number().min(0).max(10).nullable(), minimumCreditsPassed: z.number().int().min(0).max(500).nullable() }),
  graduationRequirementsByDepartment: z.record(z.string().trim().min(1).max(120), z.object({ minimumCreditsPassed: z.number().int().min(0).max(800), minimumCGPA: z.number().min(0).max(10) })),
  attendanceMinimumPercent: z.number().min(0).max(100).nullable(),
  examEligibilityRequiresPublishedAttendance: z.boolean(),
  retakePolicy: z.enum(['LATEST_RESULT','HIGHEST_GRADE_POINT','ALL_ATTEMPTS_COUNT','MANUAL_REVIEW']),
}).strict();
router.get('/student-academic-policy', async (_req,res,next) => {
  try { const row = await SystemSetting.findOne({key:'student-academic-policy'}).lean(); res.json({policy:row?.value||null,configured:Boolean(row)}); }
  catch(e) { next(e); }
});
router.put('/student-academic-policy', async (req,res,next) => {
  try {
    const policy = studentAcademicPolicySchema.parse(req.body);
    for (const [session,window] of Object.entries(policy.registrationWindows)) {
      if (window.openAt && window.closeAt && Date.parse(window.openAt) >= Date.parse(window.closeAt)) return res.status(400).json({message:`Registration window for ${session}: openAt must be before closeAt.`});
    }
    for (const row of policy.gradingScale) if (row.minScore > row.maxScore) return res.status(400).json({message:'Each grading-scale minimum must be less than or equal to its maximum.'});
    const previous = await SystemSetting.findOne({key:'student-academic-policy'}).lean();
    await SystemSetting.findOneAndUpdate({key:'student-academic-policy'},{$set:{value:{...policy,updatedAt:new Date().toISOString(),updatedBy:req.user!.id},updatedBy:req.user!.id}},{upsert:true,new:true,setDefaultsOnInsert:true});
    await audit(req,'STUDENT_ACADEMIC_POLICY_CONFIGURED','SystemSetting','student-academic-policy',{policyVersion:policy.policyVersion,sessionCount:Object.keys(policy.registrationWindows).length,gradingBandCount:policy.gradingScale.length,previouslyConfigured:Boolean(previous)});
    res.json({policy,message:'Student academic policy saved. Changes apply to future workflow checks; existing official results are not rewritten.'});
  } catch(e) { next(e); }
});

router.get('/staff/lecturers', async (_req,res,next) => {
  try { const staff = await User.find({ role:{ $in:['LECTURER','LECTURER_HOD'] } }).select('fullName email role status department appointmentDepartment faculty hodScope staffId staffIdGeneratedAt createdAt').sort({fullName:1}).limit(500); res.json({staff}); }
  catch(e) { next(e); }
});
export default router;

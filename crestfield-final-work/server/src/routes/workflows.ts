import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { authenticate, allowRoles } from '../middleware/auth.js';
import { RecordModel } from '../models/Record.js';
import { User } from '../models/User.js';
import { Application } from '../models/Application.js';
import { SystemSetting } from '../models/SystemSetting.js';
import { audit } from '../services/audit.js';
import { notify, queueEmailUserIfEnabled } from '../services/notifications.js';
import { evaluateCapacity, evaluateGraduation, evaluateProgression } from '../engines/workflowEvaluators.js';

const router = Router();
router.use(authenticate);
const studentRoles = ['ADMITTED_STUDENT','REGISTERED_STUDENT','GRADUATED_STUDENT','STUDENT'];
const teachingRoles = ['LECTURER','LECTURER_HOD'] as const;
const lecturerStages = ['course-assignment','assessment-results'] as const;
const hostelActions = ['room','maintenance','reservation','allocation','checkout'] as const;

// Canonical student summary keeps the portal anchored to the authenticated account, not client-supplied IDs.
router.get('/student/me/overview', async (req,res,next) => {
  try {
    const account=await User.findById(req.user!.id).select('fullName email role status matricNumber admissionSession department faculty createdAt').lean();
    if(!account) return res.status(404).json({message:'Student account not found.'});
    if(!['APPLICANT','ADMITTED_STUDENT','REGISTERED_STUDENT','GRADUATED_STUDENT','STUDENT'].includes(String(account.role))) return res.status(403).json({message:'This account is not in the student lifecycle.'});
    const [requests,applications,officialResults,attendanceRows,clearances]=await Promise.all([
      RecordModel.find({module:'student-workflow',ownerId:req.user!.id}).sort({createdAt:-1}).limit(100).select('title status reference data.stage data.session data.semester data.decision data.submittedAt createdAt updatedAt').lean(),
      account.role==='APPLICANT' ? (await import('../models/Application.js')).Application.find({applicantId:req.user!.id}).sort({createdAt:-1}).limit(20).select('applicationNumber session status paymentStatus eligibility offers createdAt').lean() : Promise.resolve([]),
      RecordModel.find({module:'academics',status:'PUBLISHED',$or:[{'data.studentId':req.user!.id},{'data.studentId':String((account as any)._id)},{'data.matricNumber':(account as any).matricNumber}]}).select('title reference data createdAt').lean(),
      RecordModel.find({module:'academics','data.kind':'attendance',$or:[{'data.studentId':req.user!.id},{'data.matricNumber':(account as any).matricNumber}]}).select('data createdAt').limit(1000).lean(),
      RecordModel.find({module:'graduation','data.studentId':req.user!.id}).select('status data.clearanceType data.session data.approvedBy').lean()
    ]);
    const academicPolicyRow=await SystemSetting.findOne({key:'student-academic-policy'}).lean() as any;const retakePolicy=String(academicPolicyRow?.value?.retakePolicy||'MANUAL_REVIEW');
    const resultRows=officialResults.map((r:any)=>({data:r.data||{},createdAt:r.createdAt})).filter((r:any)=>Number.isFinite(Number(r.data.gradePoint))&&Number(r.data.gradePoint)>=0&&Number.isFinite(Number(r.data.credits))&&Number(r.data.credits)>0);
    const byCourse=new Map<string,any[]>();for(const row of resultRows){const code=String(row.data.courseCode||row.data.course||row.data.code||'').trim().toUpperCase();if(!code)continue;byCourse.set(code,[...(byCourse.get(code)||[]),row]);}
    let cgpaRows=resultRows;
    if(retakePolicy==='LATEST_RESULT')cgpaRows=[...byCourse.values()].map(rows=>rows.sort((a,b)=>new Date(b.createdAt||0).getTime()-new Date(a.createdAt||0).getTime())[0]);
    else if(retakePolicy==='HIGHEST_GRADE_POINT')cgpaRows=[...byCourse.values()].map(rows=>rows.sort((a,b)=>Number(b.data.gradePoint)-Number(a.data.gradePoint))[0]);
    else if(retakePolicy==='MANUAL_REVIEW'&&[...byCourse.values()].some(rows=>rows.length>1))cgpaRows=[];
    const credits=cgpaRows.reduce((n:number,r:any)=>n+Number(r.data.credits),0);const weightedPoints=cgpaRows.reduce((n:number,r:any)=>n+Number(r.data.gradePoint)*Number(r.data.credits),0);
    const latestTerm=resultRows.reduce((latest:any,row:any)=>{const d=row.data;const term=`${d.session||''}::${d.semester||''}`;const stamp=new Date(row.createdAt||0).getTime();return !latest||stamp>latest.stamp?{term,stamp}:latest;},null)?.term;
    const termRows=latestTerm?cgpaRows.filter((r:any)=>`${r.data.session||''}::${r.data.semester||''}`===latestTerm):[];const termCredits=termRows.reduce((n:number,r:any)=>n+Number(r.data.credits),0);const gpa=termCredits?Number((termRows.reduce((n:number,r:any)=>n+Number(r.data.gradePoint)*Number(r.data.credits),0)/termCredits).toFixed(2)):null;
    const attendance=attendanceRows.map((r:any)=>r.data||{});const attendanceCount=attendance.length;const presentCount=attendance.filter((d:any)=>['PRESENT','P','ATTENDED'].includes(String(d.status||d.attendanceStatus||'').toUpperCase())).length;const absentCount=attendance.filter((d:any)=>['ABSENT','A','MISSED'].includes(String(d.status||d.attendanceStatus||'').toUpperCase())).length;
    const clearanceTypes=['academic','finance','library','department'];const graduationSessions=[...new Set(clearances.map((c:any)=>String(c.data?.session||'')).filter(Boolean))];
    const graduationProgress=graduationSessions.map(session=>{const approved=new Set(clearances.filter((c:any)=>c.status==='APPROVED'&&c.data?.approvedBy&&String(c.data?.session)===session).map((c:any)=>String(c.data?.clearanceType)));return {session,approvedClearances:clearanceTypes.filter(t=>approved.has(t)),missingClearances:clearanceTypes.filter(t=>!approved.has(t)),clearanceComplete:clearanceTypes.every(t=>approved.has(t))};});
    res.json({account,requests,applications,academicSummary:{officialPublishedResultCount:officialResults.length,gradePointResultCount:resultRows.length,totalCredits:credits||null,cgpa:credits?Number((weightedPoints/credits).toFixed(2)):null,gpa,latestGpaTerm:latestTerm?latestTerm.replace('::',' / '):null,retakePolicy,retakePolicyNote:retakePolicy==='MANUAL_REVIEW'&&cgpaRows.length===0?'Multiple attempts exist for at least one course; CGPA is withheld until the institution resolves retake treatment.':'CGPA uses the configured institutional retake policy.',gpaPolicy:'Calculated only from official PUBLISHED result records that explicitly contain numeric gradePoint and credits; no grading scale is inferred.',retakeRequests:requests.filter((r:any)=>r.data?.stage==='retake-request').map((r:any)=>({title:r.title,status:r.status,session:r.data?.session,courseCodes:r.data?.courseCodes||[]}))},attendanceSummary:{recordCount:attendanceCount,present:presentCount,absent:absentCount,percentage:attendanceCount?Number((presentCount/attendanceCount*100).toFixed(1)):null,policyStatus:attendanceCount?'REPORTED_FROM_AVAILABLE_RECORDS':'NO_ATTENDANCE_RECORDS',eligibilityDecisionMade:false},graduationProgress,lifecycle:{currentStage:account.role==='APPLICANT'?'APPLICANT':account.role,matriculationRequired:['ADMITTED_STUDENT'].includes(String(account.role)),courseRegistrationAvailable:account.role==='REGISTERED_STUDENT',alumniServicesAvailable:account.role==='GRADUATED_STUDENT'}});
  }catch(e){next(e);}
});

// A matriculation number is generated directly by an eligible newly admitted student only after the Registrar enables that student's admission session.
router.get('/student/me/matriculation-access', async (req,res,next) => {
  try {
    const student=await User.findById(req.user!.id).select('role matricNumber admissionSession department faculty').lean() as any;
    if(!student) return res.status(404).json({message:'Student account not found.'});
    const settings=await SystemSetting.findOne({key:'matriculation'}).lean() as any;
    const cfg=settings?.value||{};
    const acceptedApplication=await Application.findOne({applicantId:req.user!.id,status:'ACCEPTED'}).sort({updatedAt:-1}).select('session firstChoiceCourse faculty offers').lean() as any;
    const session=String(student.admissionSession||acceptedApplication?.session||'');
    const acceptedOffer=[...(acceptedApplication?.offers||[])].reverse().find((o:any)=>o.status==='ACCEPTED');
    const departmentKey=String(student.department||acceptedOffer?.programme||acceptedApplication?.firstChoiceCourse||'').trim();
    const departmentCode=cfg.departmentCodes?.[departmentKey];
    const enabled=Boolean(student.role==='ADMITTED_STUDENT'&&!student.matricNumber&&session&&cfg.enabled===true&&cfg.sessions?.[session]?.enabled===true&&departmentCode);
    res.json({eligible:enabled,role:student.role,matricNumber:student.matricNumber||null,session:session||null,department:departmentKey||null,sessionEnabled:Boolean(session&&cfg.enabled===true&&cfg.sessions?.[session]?.enabled===true),departmentConfigured:Boolean(departmentKey&&departmentCode),message:enabled?'Matriculation number generation is open for your admission session.':student.role!=='ADMITTED_STUDENT'?'Only newly admitted students without a matriculation number can generate one.':student.matricNumber?'Your matriculation number has already been generated.':!session?'Your admitted academic session could not be determined. Contact the Registrar.':'The Registrar has not enabled matriculation generation for your admission session or the accepted programme/department code is not configured.'});
  } catch(e){next(e);}
});

router.post('/student/me/generate-matriculation', async (req,res,next) => {
  const dbSession=await mongoose.startSession();
  try {
    let result:any=null;
    await dbSession.withTransaction(async()=>{
      const student=await User.findById(req.user!.id).session(dbSession);
      if(!student) throw Object.assign(new Error('Student account not found.'),{status:404});
      if(student.role!=='ADMITTED_STUDENT') throw Object.assign(new Error('Only newly admitted students can generate a matriculation number. Registered and graduated students cannot generate another number.'),{status:403});
      if(student.matricNumber) throw Object.assign(new Error('Your matriculation number has already been generated. The generation button is no longer available.'),{status:409});
      let admissionSession=String((student as any).admissionSession||'');
      if(!admissionSession){const acceptedApplication=await Application.findOne({applicantId:student._id,status:'ACCEPTED'}).sort({updatedAt:-1}).select('session').session(dbSession).lean();admissionSession=String((acceptedApplication as any)?.session||'');if(admissionSession)(student as any).admissionSession=admissionSession;}
      if(!admissionSession) throw Object.assign(new Error('Your admitted academic session is missing. Contact the Registrar.'),{status:409});
      const setting=await SystemSetting.findOne({key:'matriculation'}).session(dbSession);
      const cfg=(setting?.value||{}) as any;
      if(!setting||cfg.enabled!==true||cfg.sessions?.[admissionSession]?.enabled!==true) throw Object.assign(new Error(`The Registrar has not enabled matriculation generation for your admitted session (${admissionSession}).`),{status:403});
      const acceptedApplication=await Application.findOne({applicantId:student._id,status:'ACCEPTED'}).sort({updatedAt:-1}).select('firstChoiceCourse faculty offers').session(dbSession).lean() as any;
      const acceptedOffer=[...(acceptedApplication?.offers||[])].reverse().find((o:any)=>o.status==='ACCEPTED');
      const departmentKey=String(student.department||acceptedOffer?.programme||acceptedApplication?.firstChoiceCourse||'').trim();
      const code=String(cfg.departmentCodes?.[departmentKey]||'').toUpperCase();
      if(!code) throw Object.assign(new Error(`The Registrar has not configured a matriculation code for the accepted programme/department “${departmentKey||'not recorded'}”. Contact the Registrar.`),{status:409});
      const yearMatch=admissionSession.match(/(?:19|20)\d{2}/);
      if(!yearMatch) throw Object.assign(new Error('The admitted session must contain a four-digit start year to generate the matriculation number.'),{status:400});
      const year=yearMatch[0].slice(-2);const sequenceKey=`${year}/${code}`;const prefix=`${year}/${code}/`;
      const used=await User.countDocuments({matricNumber:{$regex:`^${prefix}`}}).session(dbSession);
      const nextSequence={...(cfg.nextSequence||{})};const serial=Math.max(Number(nextSequence[sequenceKey]||1),used+1);
      if(!Number.isSafeInteger(serial)||serial>9999) throw Object.assign(new Error('The four-digit matriculation sequence for this department and session is exhausted.'),{status:409});
      nextSequence[sequenceKey]=serial+1;setting.value={...cfg,nextSequence,updatedAt:new Date().toISOString(),updatedBy:req.user!.id};setting.updatedBy=new mongoose.Types.ObjectId(req.user!.id);await setting.save({session:dbSession});
      student.matricNumber=`${prefix}${String(serial).padStart(4,'0')}`;student.role='REGISTERED_STUDENT';student.mustChangePassword=true;await student.save({session:dbSession});
      result={matricNumber:student.matricNumber,admissionSession,role:student.role};
    });
    await audit(req,'STUDENT_MATRICULATION_NUMBER_GENERATED','User',req.user!.id,{matricNumber:result.matricNumber,admissionSession:result.admissionSession,format:'YY/DEPARTMENTCODE/NNNN'});
    await notify(req.user!.id,'Matriculation number generated',`Your matriculation number is ${result.matricNumber}. You are now a Registered Student.`).catch(error=>console.error('Matriculation notification failed:',error));
    res.status(201).json({student:result,message:`Your matriculation number ${result.matricNumber} has been generated. The button is now removed because you have moved to Registered Student.`});
  } catch(e){next(e);} finally {await dbSession.endSession();}
});

// Student lifecycle: Applicant -> Admitted Student -> Registered Student -> Graduated Student.
// The student may request actions; only the Registrar can approve official lifecycle transitions.
const studentStages = ['course-registration','academic-records','progression-review','retake-request','exam-eligibility-review','deferment-request','attendance-appeal','graduation-clearance','alumni-record-request'] as const;
const studentStageRoles: Record<(typeof studentStages)[number], string[]> = {
  'course-registration':['REGISTERED_STUDENT'],
  'academic-records':['REGISTERED_STUDENT','GRADUATED_STUDENT'],
  'progression-review':['REGISTERED_STUDENT'],
  'retake-request':['REGISTERED_STUDENT'],
  'exam-eligibility-review':['REGISTERED_STUDENT'],
  'deferment-request':['REGISTERED_STUDENT'],
  'attendance-appeal':['REGISTERED_STUDENT'],
  'graduation-clearance':['REGISTERED_STUDENT'],
  'alumni-record-request':['GRADUATED_STUDENT'],
};
const studentPayload = z.object({
  title:z.string().trim().min(2).max(180),
  session:z.string().trim().min(4).max(30).optional(),
  semester:z.string().trim().max(30).optional(),
  level:z.union([z.string().trim().max(30),z.number().int().min(100).max(900)]).optional(),
  courseCodes:z.array(z.string().trim().min(2).max(20)).max(30).optional(),
  reason:z.string().trim().max(2000).optional(),
  evidence:z.record(z.string(),z.unknown()).optional(),
  requestType:z.string().trim().max(80).optional(),
}).strict();
router.post('/student/:stage', async (req,res,next) => {
  try {
    const stage = z.enum(studentStages).parse(req.params.stage);
    const role = req.user!.role;
    if (role === 'APPLICANT' || role === 'STUDENT') return res.status(403).json({message:'Applicants use the Admissions portal. Student lifecycle services become available after an official admission.'});
    if (role === 'REGISTRAR') return res.status(403).json({message:'Registrar decisions and status transitions must use the student review endpoint, not submit a student request.'});
    if (!studentStageRoles[stage].includes(role)) return res.status(403).json({message:`Your ${role.replaceAll('_',' ').toLowerCase()} status cannot submit this workflow stage.`});
    const body = studentPayload.parse(req.body);
    let policyEvaluation:any=null;
    if (stage === 'course-registration') {
      const studentAccount = await User.findById(req.user!.id).select('matricNumber');
      if (!studentAccount?.matricNumber) return res.status(409).json({message:'A matriculation number must be assigned before course registration can be submitted.'});
      if (!body.session || !body.semester || !body.courseCodes?.length) return res.status(400).json({message:'Course registration requires an academic session, semester, and at least one course code.'});
      const normalizedCodes=body.courseCodes.map(c=>c.trim().toUpperCase());
      const unique = new Set(normalizedCodes);
      if (unique.size !== body.courseCodes.length) return res.status(400).json({message:'Duplicate course codes are not allowed in a registration request.'});
      const academicPolicyRow=await SystemSetting.findOne({key:'student-academic-policy'}).lean() as any;
      const academicPolicy=academicPolicyRow?.value||null;
      if(!academicPolicy) return res.status(409).json({message:'The Registrar must configure and version the student academic policy before course registration can be submitted. No credit limits or registration dates are guessed.'});
      const window=academicPolicy.registrationWindows?.[body.session];
      if(!window?.enabled) return res.status(409).json({message:`Course registration is not enabled for academic session ${body.session}.`});
      const now=Date.now();
      if(window.openAt && now<Date.parse(window.openAt)) return res.status(409).json({message:`Registration for ${body.session} opens on ${window.openAt}.`});
      if(window.closeAt && now>Date.parse(window.closeAt)) return res.status(409).json({message:`The registration deadline for ${body.session} (${window.closeAt}) has passed.`});
      const catalogue=await RecordModel.find({module:'registrar','data.category':'course',status:{$in:['APPROVED','PUBLISHED','ACTIVE']}}).select('title reference data').lean();
      if(!catalogue.length) return res.status(409).json({message:'The Registrar has not published an approved course catalogue yet. Course registration cannot accept unverified free-text course codes.'});
      const byCode=new Map<string,any>();for(const course of catalogue){const d:any=course.data||{};const code=String(d.courseCode||d.code||course.reference||'').trim().toUpperCase();if(code)byCode.set(code,course);}
      const unknown=normalizedCodes.filter(code=>!byCode.has(code));
      if(unknown.length) return res.status(400).json({message:`These course codes are not in the approved course catalogue: ${unknown.join(', ')}.`});
      const student=await User.findById(req.user!.id).select('department faculty matricNumber');
      const mismatched=normalizedCodes.filter(code=>{const d:any=byCode.get(code)?.data||{};return (d.department&&student?.department&&String(d.department).toLowerCase()!==String(student.department).toLowerCase())||(d.faculty&&student?.faculty&&String(d.faculty).toLowerCase()!==String(student.faculty).toLowerCase());});
      if(mismatched.length) return res.status(400).json({message:`These courses are outside the student's configured department or faculty: ${mismatched.join(', ')}.`});
      const levelKey=String(body.level||'');
      const creditRule=academicPolicy.creditLimitsByLevel?.[levelKey];
      if(!creditRule) return res.status(409).json({message:`The Registrar has not configured a credit limit for student level ${levelKey||'(not supplied)'}.`});
      const selectedCourses=normalizedCodes.map(code=>byCode.get(code));
      for(const course of selectedCourses){const d:any=course?.data||{};if(d.session && String(d.session)!==body.session)return res.status(400).json({message:`Course ${d.courseCode||d.code||course.reference} is not offered in ${body.session}.`});if(d.semester && String(d.semester).toLowerCase()!==String(body.semester).toLowerCase())return res.status(400).json({message:`Course ${d.courseCode||d.code||course.reference} is not offered in ${body.semester}.`});}
      const totalCredits=selectedCourses.reduce((sum:number,course:any)=>sum+Number((course.data||{}).credits||0),0);
      if(selectedCourses.some((course:any)=>!Number.isFinite(Number((course.data||{}).credits))||Number((course.data||{}).credits)<=0)) return res.status(409).json({message:'Every selected course must have a positive credit value in the approved catalogue.'});
      if(totalCredits<creditRule.min||totalCredits>creditRule.max)return res.status(400).json({message:`Selected courses total ${totalCredits} credits; the configured range for level ${levelKey} is ${creditRule.min}–${creditRule.max}.`});
      const prerequisites=[...new Set(selectedCourses.flatMap((course:any)=>{const d:any=course.data||{};const raw=d.prerequisites||d.prerequisiteCourseCodes||[];return Array.isArray(raw)?raw.map((x:any)=>String(x).trim().toUpperCase()).filter(Boolean):String(raw).split(',').map((x:string)=>x.trim().toUpperCase()).filter(Boolean);} ))];
      const publishedResults=await RecordModel.find({module:'academics',status:'PUBLISHED',$or:[{'data.studentId':req.user!.id},{'data.matricNumber':(student as any)?.matricNumber}]}).select('data').lean();
      const passedCodes=new Set(publishedResults.filter((r:any)=>{const d=r.data||{};return d.passed===true||String(d.resultStatus||d.outcome||'').toUpperCase()==='PASS';}).map((r:any)=>String((r.data||{}).courseCode||(r.data||{}).course||'').trim().toUpperCase()).filter(Boolean));
      const missingPrerequisites=prerequisites.filter(code=>!passedCodes.has(code));
      if(missingPrerequisites.length)return res.status(409).json({message:`Prerequisite completion could not be confirmed from official published results for: ${missingPrerequisites.join(', ')}. Contact your department if the records are incorrect.`});
      const prior = await RecordModel.findOne({module:'student-workflow',ownerId:req.user!.id,status:{$in:['SUBMITTED','UNDER_REVIEW','APPROVED']},'data.stage':stage,'data.session':body.session,'data.semester':body.semester});
      if (prior) return res.status(409).json({message:'A course-registration request already exists for this session and semester. Use the existing request rather than creating a duplicate.'});
    }
    if (stage === 'retake-request' && (!body.session || !body.courseCodes?.length || !body.reason)) return res.status(400).json({message:'A retake request requires an academic session, at least one course code, and a reason.'});
    if(stage==='retake-request'){const codes=body.courseCodes!.map(c=>c.trim().toUpperCase());if(new Set(codes).size!==codes.length)return res.status(400).json({message:'Duplicate course codes are not allowed in a retake request.'});const me=await User.findById(req.user!.id).select('matricNumber');const results=await RecordModel.find({module:'academics',status:'PUBLISHED',$or:[{'data.studentId':req.user!.id},{'data.matricNumber':me?.matricNumber}]}).select('data').lean();const resultCodes=new Set(results.filter((r:any)=>{const d=r.data||{};return d.passed===false||['FAIL','FAILED'].includes(String(d.resultStatus||d.outcome||'').toUpperCase());}).map((r:any)=>String((r.data||{}).courseCode||(r.data||{}).course||'').trim().toUpperCase()));const invalid=codes.filter(code=>!resultCodes.has(code));if(invalid.length)return res.status(409).json({message:`A retake request can only be made for courses with an official published failed result. This could not be confirmed for: ${invalid.join(', ')}.`});}
    if(stage==='progression-review'){const policyRow=await SystemSetting.findOne({key:'student-academic-policy'}).lean() as any;const policy=policyRow?.value;if(!policy) return res.status(409).json({message:'The Registrar must configure the student academic policy before a progression review can be evaluated.'});const me=await User.findById(req.user!.id).select('matricNumber');const results=await RecordModel.find({module:'academics',status:'PUBLISHED',$or:[{'data.studentId':req.user!.id},{'data.matricNumber':me?.matricNumber}]}).select('data').lean();const rows=results.map((r:any)=>r.data||{}).filter((d:any)=>Number.isFinite(Number(d.gradePoint))&&Number(d.gradePoint)>=0&&Number.isFinite(Number(d.credits))&&Number(d.credits)>0);const total=rows.reduce((n:number,d:any)=>n+Number(d.credits),0);const weighted=rows.reduce((n:number,d:any)=>n+Number(d.gradePoint)*Number(d.credits),0);const cgpa=total?weighted/total:null;const passed=rows.filter((d:any)=>d.passed===true||String(d.resultStatus||d.outcome||'').toUpperCase()==='PASS').reduce((n:number,d:any)=>n+Number(d.credits),0);const rules=policy.progressionRules||{};policyEvaluation={policyVersion:policy.policyVersion,officialPublishedResultCount:rows.length,cgpa:cgpa===null?null:Number(cgpa.toFixed(2)),passedCredits:passed,checks:{minimumCGPA:rules.minimumCGPA==null?'NOT_CONFIGURED':cgpa!==null&&cgpa>=rules.minimumCGPA,minimumCreditsPassed:rules.minimumCreditsPassed==null?'NOT_CONFIGURED':passed>=rules.minimumCreditsPassed},humanDecisionRequired:true};}
    if(stage==='exam-eligibility-review'){const policyRow=await SystemSetting.findOne({key:'student-academic-policy'}).lean() as any;const policy=policyRow?.value;if(!policy)return res.status(409).json({message:'The Registrar must configure the student academic policy before an exam-eligibility review can be evaluated.'});const minAttendance=policy.attendanceMinimumPercent;const me=await User.findById(req.user!.id).select('matricNumber');const attendanceRows=await RecordModel.find({module:'academics','data.kind':'attendance','data.session':body.session,'data.semester':body.semester,$or:[{'data.studentId':req.user!.id},{'data.matricNumber':me?.matricNumber}]}).select('data').lean();const relevant=attendanceRows.filter((r:any)=>!r.data?.courseCode||body.courseCodes!.map(c=>c.toUpperCase()).includes(String(r.data.courseCode).toUpperCase()));const present=relevant.filter((r:any)=>['PRESENT','P','ATTENDED'].includes(String(r.data?.status||r.data?.attendanceStatus||'').toUpperCase())).length;const pct=relevant.length?present/relevant.length*100:null;policyEvaluation={policyVersion:policy.policyVersion,attendanceRecords:relevant.length,attendancePercentage:pct===null?null:Number(pct.toFixed(1)),configuredMinimumAttendance:minAttendance??null,attendanceCheck:minAttendance==null?'NOT_CONFIGURED':pct===null?'INSUFFICIENT_RECORDS':pct>=minAttendance?'MEETS_CONFIGURED_THRESHOLD':'BELOW_CONFIGURED_THRESHOLD',humanDecisionRequired:true,officialEligibilityChanged:false};}
    if (stage === 'exam-eligibility-review' && (!body.session || !body.semester || !body.courseCodes?.length)) return res.status(400).json({message:'Exam eligibility review requires a session, semester, and the relevant course code(s). Eligibility remains pending authorized review.'});
    if (stage === 'graduation-clearance' && !body.session) return res.status(400).json({message:'Graduation clearance requires the intended graduation session.'});
    if (stage === 'graduation-clearance') { const me=await User.findById(req.user!.id).select('matricNumber role'); if(!me?.matricNumber || me.role!=='REGISTERED_STUDENT') return res.status(409).json({message:'Only a matriculated registered student may request graduation clearance.'}); }
    if (stage === 'deferment-request' && !body.reason) return res.status(400).json({message:'Explain the reason for your deferment request.'});
    if (stage === 'attendance-appeal' && !body.reason) return res.status(400).json({message:'Explain the attendance decision you are appealing and why.'});
    const duplicateQuery:any={module:'student-workflow',ownerId:req.user!.id,'data.stage':stage,status:{$in:['SUBMITTED','UNDER_REVIEW']}};
    if (body.session) duplicateQuery['data.session']=body.session;
    if (stage !== 'academic-records' && stage !== 'alumni-record-request') {
      const duplicate=await RecordModel.findOne(duplicateQuery);
      if(duplicate) return res.status(409).json({message:'A request for this workflow stage is already awaiting review.'});
    }
    const record = await RecordModel.create({module:'student-workflow',title:body.title,status:'SUBMITTED',ownerId:req.user!.id,reference:`${stage}:${req.user!.id}:${new mongoose.Types.ObjectId().toString()}`,data:{stage,...body,...(stage==='course-registration'?{courseCodes:body.courseCodes?.map(c=>c.trim().toUpperCase())}:{}),...(policyEvaluation?{policyEvaluation}:{}),studentId:req.user!.id,submittedBy:req.user!.id,submittedAt:new Date().toISOString(),approvalRequired:true,officialStatusChanged:false,policyVersion:'student-lifecycle-v1'},createdBy:req.user!.id,updatedBy:req.user!.id});
    await audit(req,'STUDENT_WORKFLOW_SUBMITTED','student-workflow',record.id,{stage,session:body.session||null,approvalRequired:true});
    const registrars=await User.find({role:'REGISTRAR',status:'ACTIVE'}).select('_id').limit(100).lean();
    await Promise.allSettled(registrars.map(r=>notify(String(r._id),'Student request awaiting review',`${body.title} was submitted by ${req.user!.id}. Stage: ${stage}; session: ${body.session||'not specified'}.`)));
    res.status(201).json({record,message:'Request submitted for review. Your official student status, registration, results, progression, and graduation status will not change until authorized approval.'});
  } catch(e){next(e);}
});

// Clearance evidence is created by the owning university unit and approved separately by the Registrar.
// A student cannot submit or approve their own clearance, and generic record endpoints cannot forge one.
const clearanceRoles:Record<string,string[]>={academic:['REGISTRAR','LECTURER','LECTURER_HOD'],finance:['REGISTRAR','BURSARY'],library:['REGISTRAR'],department:['REGISTRAR','LECTURER_HOD']};
router.post('/clearances/:type', async (req,res,next)=>{
  try{
    const type=z.enum(['academic','finance','library','department']).parse(req.params.type);
    if(!clearanceRoles[type].includes(req.user!.role)) return res.status(403).json({message:'Your role is not authorized to submit this clearance type.'});
    const body=z.object({studentId:z.string().refine(mongoose.isValidObjectId,'Invalid student ID'),session:z.string().trim().min(4).max(30),details:z.string().trim().min(5).max(2000),evidenceReference:z.string().trim().max(180).optional()}).strict().parse(req.body);
    const student=await User.findById(body.studentId).select('role matricNumber fullName');
    if(!student || !['REGISTERED_STUDENT','GRADUATED_STUDENT'].includes(String(student.role)) || !student.matricNumber) return res.status(409).json({message:'Clearance must reference an existing matriculated registered student.'});
    const duplicate=await RecordModel.findOne({module:'graduation','data.studentId':String(student._id),'data.clearanceType':type,'data.session':body.session,status:{$in:['SUBMITTED','UNDER_REVIEW','APPROVED']}});
    if(duplicate) return res.status(409).json({message:`A ${type} clearance record already exists for this student and session.`});
    const record=await RecordModel.create({module:'graduation',title:`${type[0].toUpperCase()+type.slice(1)} clearance — ${student.matricNumber}`,status:'SUBMITTED',reference:`clearance:${type}:${student._id}:${body.session}:${new mongoose.Types.ObjectId()}`,data:{studentId:String(student._id),studentName:student.fullName,matricNumber:student.matricNumber,clearanceType:type,session:body.session,details:body.details,evidenceReference:body.evidenceReference||null,submittedBy:req.user!.id,submittedByRole:req.user!.role,submittedAt:new Date().toISOString(),decisionHistory:[]},createdBy:req.user!.id,updatedBy:req.user!.id});
    await audit(req,'STUDENT_CLEARANCE_SUBMITTED','graduation',record.id,{studentId:String(student._id),clearanceType:type,session:body.session});
    const registrars=await User.find({role:'REGISTRAR',status:'ACTIVE'}).select('_id').limit(100).lean();
    await Promise.allSettled(registrars.map(r=>notify(String(r._id),'Graduation clearance awaiting review',`${type} clearance for ${student.matricNumber}, session ${body.session}, was submitted by ${req.user!.role}.`)));
    res.status(201).json({record,message:'Clearance evidence submitted. It will count toward graduation only after the Registrar approves it.'});
  }catch(e){next(e);}
});
router.post('/clearances/:id/decision',allowRoles('REGISTRAR'),async(req,res,next)=>{
  try{
    if(!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({message:'Invalid clearance record identifier.'});
    const body=z.object({outcome:z.enum(['APPROVED','REJECTED','NEEDS_INFORMATION']),reason:z.string().trim().min(5).max(2000),policyVersion:z.string().trim().min(1).max(100).default('graduation-clearance-v1')}).strict().parse(req.body);
    const record=await RecordModel.findOne({_id:req.params.id,module:'graduation'});
    if(!record) return res.status(404).json({message:'Clearance record not found.'});
    if(!['SUBMITTED','UNDER_REVIEW','NEEDS_INFORMATION'].includes(record.status)) return res.status(409).json({message:'This clearance has already been finalized.'});
    const data:any=record.data||{};const type=String(data.clearanceType||'');
    if(!clearanceRoles[type]) return res.status(409).json({message:'This record is not a recognized canonical student clearance.'});
    const creator=await User.findById(String(record.createdBy)).select('role');
    if(!creator||!clearanceRoles[type].includes(String(creator.role))) return res.status(403).json({message:'The clearance submitter is not authorized for this clearance type.'});
    const decision={outcome:body.outcome,reason:body.reason,decidedBy:req.user!.id,decidedAt:new Date().toISOString(),policyVersion:body.policyVersion};
    record.status=body.outcome;record.data={...data,decision,decisionHistory:[...(Array.isArray(data.decisionHistory)?data.decisionHistory:[]),decision],approvedAt:body.outcome==='APPROVED'?decision.decidedAt:null,approvedBy:body.outcome==='APPROVED'?req.user!.id:null};record.updatedBy=new mongoose.Types.ObjectId(req.user!.id);await record.save();
    await audit(req,'STUDENT_CLEARANCE_DECIDED','graduation',record.id,{studentId:data.studentId,clearanceType:type,outcome:body.outcome,reason:body.reason});
    const message=`Your ${type} graduation clearance for ${data.session} was ${body.outcome.toLowerCase().replaceAll('_',' ')}. Registrar note: ${body.reason}`;
    await Promise.allSettled([notify(String(data.studentId),'Graduation clearance update',message),queueEmailUserIfEnabled(String(data.studentId),`graduation-clearance:${record.id}:${body.outcome}`,'Graduation clearance update',message)]);
    res.json({record,message:`${type} clearance decision recorded: ${body.outcome}.`});
  }catch(e){next(e);}
});

// Registrar review applies decisions to the canonical request and, only for approved
// lifecycle transitions, updates the student's role/account in the same transaction.
router.post('/student/:id/decision', allowRoles('REGISTRAR'), async (req,res,next) => {
  const session = await mongoose.startSession();
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({message:'Invalid student workflow record identifier.'});
    const body=z.object({outcome:z.enum(['APPROVED','REJECTED','NEEDS_INFORMATION']),reason:z.string().trim().min(5).max(2000),departmentCode:z.string().trim().regex(/^[A-Za-z0-9]{2,12}$/).optional(),policyVersion:z.string().trim().min(1).max(100).default('student-lifecycle-v1')}).parse(req.body);
    let output:any=null;
    await session.withTransaction(async()=>{
      const record=await RecordModel.findOne({_id:req.params.id,module:'student-workflow'}).session(session);
      if(!record) throw Object.assign(new Error('Student workflow request not found.'),{status:404});
      if(!['SUBMITTED','UNDER_REVIEW','NEEDS_INFORMATION'].includes(record.status)) throw Object.assign(new Error(`This request is already ${record.status} and cannot receive another initial decision.`),{status:409});
      const data:any=record.data||{}; const stage=String(data.stage||'');
      if(stage==='matriculation-request') throw Object.assign(new Error('Matriculation requests are no longer used. The Registrar must enable generation for the admitted session, then the newly admitted student generates the number directly.'),{status:409});
      const student=await User.findById(String(data.studentId||record.ownerId)).session(session);
      if(!student) throw Object.assign(new Error('The student account linked to this request was not found.'),{status:404});
      const decision={outcome:body.outcome,reason:body.reason,decidedBy:req.user!.id,decidedAt:new Date().toISOString(),policyVersion:body.policyVersion};
      if(body.outcome==='APPROVED' && stage==='course-registration'){
        if(student.role!=='REGISTERED_STUDENT' || !student.matricNumber) throw Object.assign(new Error('Only a matriculated registered student can receive an approved course registration.'),{status:409});
        const academicPolicyRow=await SystemSetting.findOne({key:'student-academic-policy'}).session(session).lean() as any;
        const academicPolicy=academicPolicyRow?.value; const window=academicPolicy?.registrationWindows?.[String(data.session||'')];
        if(!academicPolicy || !window?.enabled) throw Object.assign(new Error('Course registration cannot be approved because the Registrar has not enabled registration for this session.'),{status:409});
        const now=Date.now(); if(window.openAt&&now<Date.parse(window.openAt)||window.closeAt&&now>Date.parse(window.closeAt)) throw Object.assign(new Error('Course registration cannot be approved outside the configured registration window.'),{status:409});
        const codes=Array.isArray(data.courseCodes)?data.courseCodes.map((c:any)=>String(c).toUpperCase()):[];
        const catalogue=await RecordModel.find({module:'registrar','data.category':'course',status:{$in:['APPROVED','PUBLISHED','ACTIVE']}}).select('reference data').session(session).lean();
        const approvedCodes=new Set(catalogue.map((course:any)=>String(course.data?.courseCode||course.data?.code||course.reference||'').trim().toUpperCase()).filter(Boolean));
        const missing=codes.filter((code:string)=>!approvedCodes.has(code));
        if(!codes.length||missing.length) throw Object.assign(new Error(`Course registration cannot be approved because the approved catalogue no longer contains: ${missing.length?missing.join(', '):'any requested courses'}.`),{status:409});
        data.registrationApprovedAt=new Date().toISOString(); data.registrationApprovedBy=req.user!.id; data.registrationApproved=true;data.officialRegistration=true;
      }
      if(body.outcome==='APPROVED' && stage==='deferment-request') data.defermentDecision='APPROVED';
      if(body.outcome==='APPROVED' && stage==='graduation-clearance'){
        if(student.role!=='REGISTERED_STUDENT') throw Object.assign(new Error('Only a registered student can be considered for graduation.'),{status:409});
        const academicPolicyRow=await SystemSetting.findOne({key:'student-academic-policy'}).session(session).lean() as any;
        const academicPolicy=academicPolicyRow?.value;
        const graduationRule=academicPolicy?.graduationRequirementsByDepartment?.[String(student.department||'')];
        if(!academicPolicy || !graduationRule) throw Object.assign(new Error(`The Registrar has not configured graduation credit and CGPA requirements for ${student.department||'this department'}.`),{status:409});
        const officialResults=await RecordModel.find({module:'academics',status:'PUBLISHED',$or:[{'data.studentId':String(student._id)},{'data.matricNumber':student.matricNumber}]}).select('data').session(session).lean();
        const rows=officialResults.map((r:any)=>({data:r.data||{},createdAt:r.createdAt})).filter((r:any)=>Number.isFinite(Number(r.data.gradePoint))&&Number(r.data.gradePoint)>=0&&Number.isFinite(Number(r.data.credits))&&Number(r.data.credits)>0);
        const grouped=new Map<string,any[]>();for(const row of rows){const code=String(row.data.courseCode||row.data.course||row.data.code||'').trim().toUpperCase();if(!code)continue;grouped.set(code,[...(grouped.get(code)||[]),row]);}
        if(String(academicPolicy.retakePolicy||'MANUAL_REVIEW')==='MANUAL_REVIEW'&&[...grouped.values()].some((attempts:any[])=>attempts.length>1)) throw Object.assign(new Error('Graduation cannot be finalized because repeated course attempts require manual resolution under the configured retake policy.'),{status:409});
        let countedRows=rows;
        if(academicPolicy.retakePolicy==='LATEST_RESULT')countedRows=[...grouped.values()].map((attempts:any[])=>attempts.sort((a,b)=>new Date(b.createdAt||0).getTime()-new Date(a.createdAt||0).getTime())[0]);
        else if(academicPolicy.retakePolicy==='HIGHEST_GRADE_POINT')countedRows=[...grouped.values()].map((attempts:any[])=>attempts.sort((a,b)=>Number(b.data.gradePoint)-Number(a.data.gradePoint))[0]);
        const passedRows=countedRows.filter((r:any)=>r.data.passed===true||String(r.data.resultStatus||r.data.outcome||'').toUpperCase()==='PASS');
        const passedCredits=passedRows.reduce((n:number,r:any)=>n+Number(r.data.credits),0);
        const totalCredits=countedRows.reduce((n:number,r:any)=>n+Number(r.data.credits),0);
        const cgpa=totalCredits?countedRows.reduce((n:number,r:any)=>n+Number(r.data.gradePoint)*Number(r.data.credits),0)/totalCredits:null;
        if(passedCredits<graduationRule.minimumCreditsPassed || cgpa===null || cgpa<graduationRule.minimumCGPA) throw Object.assign(new Error(`Academic graduation requirements are not met from official published results. Passed credits: ${passedCredits}/${graduationRule.minimumCreditsPassed}; CGPA: ${cgpa===null?'unavailable':cgpa.toFixed(2)} (minimum ${graduationRule.minimumCGPA}).`),{status:409});
        // Never trust clearance names submitted by the student. Each clearance must exist as
        // a separate approved canonical record created by its owning university workflow.
        const required=['academic','finance','library','department'];
        const candidates=await RecordModel.find({module:'graduation',status:'APPROVED','data.studentId':String(student._id),'data.session':String(data.session),'data.clearanceType':{$in:required},'data.approvedBy':{$exists:true}}).session(session).lean();
        const creatorIds=[...new Set(candidates.map((r:any)=>String(r.createdBy||'' )).filter(Boolean))];
        const creators=await User.find({_id:{$in:creatorIds}}).select('role').session(session).lean();
        const roleById=new Map(creators.map((u:any)=>[String(u._id),String(u.role)]));
        const allowedCreators:Record<string,string[]>={academic:['REGISTRAR','LECTURER','LECTURER_HOD'],finance:['REGISTRAR','BURSARY'],library:['REGISTRAR'],department:['REGISTRAR','LECTURER_HOD']};
        const verified=candidates.filter((r:any)=>allowedCreators[String(r.data?.clearanceType)]?.includes(roleById.get(String(r.createdBy||''))||''));
        const verifiedTypes=new Set(verified.map((r:any)=>String(r.data?.clearanceType)));
        const missing=required.filter(x=>!verifiedTypes.has(x));
        if(missing.length) throw Object.assign(new Error(`Graduation clearance is missing independently approved records from the authorized owning units for: ${missing.join(', ')}. Student-created records cannot satisfy these gates.`),{status:409});
        student.role='GRADUATED_STUDENT'; data.graduatedAt=new Date().toISOString(); data.graduatedBy=req.user!.id; data.verifiedClearanceRecordIds=verified.map((r:any)=>String(r._id));
        await student.save({session});
      }
      if(body.outcome==='APPROVED' && stage==='deferment-request') data.defermentApprovedAt=new Date().toISOString();
      record.status=body.outcome; record.data={...data,decision,decisionHistory:[...(Array.isArray(data.decisionHistory)?data.decisionHistory:[]),decision],officialStatusChanged:body.outcome==='APPROVED'&&['graduation-clearance'].includes(stage)};
      record.updatedBy=new mongoose.Types.ObjectId(req.user!.id); await record.save({session});
      output={record,student:{id:String(student._id),role:student.role,matricNumber:student.matricNumber||null}};
    });
    if(output){
      await audit(req,'STUDENT_WORKFLOW_DECIDED','student-workflow',String(output.record._id),{outcome:body.outcome,reason:body.reason,studentId:output.student.id,studentRole:output.student.role,matricNumber:output.student.matricNumber});
      const stage=String((output.record.data as any)?.stage||'student workflow');const title='Update on your student request';const message=`Your ${stage.replaceAll('-',' ')} request was ${body.outcome.toLowerCase().replaceAll('_',' ')}. Registrar note: ${body.reason}`;
      await Promise.allSettled([notify(output.student.id,title,message),queueEmailUserIfEnabled(output.student.id,`student-workflow:${String(output.record._id)}:${body.outcome}`,title,message)]);
    }
    res.json({...output,message:`Student workflow decision recorded: ${body.outcome}.`});
  }catch(e){next(e);}finally{await session.endSession();}
});

// Lecturers can prepare course/assessment records; official publication and appointment decisions
// remain controlled by Registrar-authorized workflows.
router.post('/lecturer/:stage', allowRoles(...teachingRoles), async (req,res,next) => {
  try {
    const stage = z.enum(lecturerStages).parse(req.params.stage);
    const body = z.object({title:z.string().trim().min(2).max(180),courseCode:z.string().trim().min(2).max(20),session:z.string().trim().min(4).max(30),semester:z.string().trim().max(30).optional(),studentReference:z.string().trim().max(100).optional(),score:z.number().min(0).max(100).optional(),note:z.string().trim().max(2000).optional()}).parse(req.body);
    if(stage==='assessment-results' && body.score===undefined) return res.status(400).json({message:'A numeric score from 0 to 100 is required for an assessment result.'});
    const lecturerAccount=await User.findById(req.user!.id).select('department appointmentDepartment faculty');const lecturerDepartment=lecturerAccount?.appointmentDepartment||lecturerAccount?.department||'';if(!lecturerDepartment)return res.status(409).json({message:'Your lecturer account must have an assigned department before submitting course or result workflows.'});const record=await RecordModel.create({module:'lecturer-workflow',title:body.title,status:'SUBMITTED_FOR_REVIEW',ownerId:req.user!.id,reference:`${stage}:${req.user!.id}:${new mongoose.Types.ObjectId().toString()}`,data:{stage,...body,department:lecturerDepartment,faculty:lecturerAccount?.faculty||'',submittedBy:req.user!.id,submittedAt:new Date().toISOString(),officialPublication:false},createdBy:req.user!.id,updatedBy:req.user!.id});
    await audit(req,'LECTURER_WORKFLOW_SUBMITTED','lecturer-workflow',record.id,{stage,courseCode:body.courseCode,officialPublication:false});
    res.status(201).json({record,message:'Submitted for the appropriate academic review. This submission does not publish an official result or change a lecturer appointment.'});
  }catch(e){next(e);}
});

// Hostel operations are records with explicit states. Capacity and occupancy are never silently
// inferred from a free-form note; allocation requires a student reference and a bed identifier.
router.post('/hostel/:action', allowRoles('HOSTEL_ADMIN','REGISTRAR'), async (req,res,next) => {
  try {
    const action=z.enum(hostelActions).parse(req.params.action);
    const body=z.object({title:z.string().trim().min(2).max(180),hostel:z.string().trim().max(100).optional(),room:z.string().trim().max(50).optional(),bed:z.string().trim().max(50).optional(),studentReference:z.string().trim().max(100).optional(),session:z.string().trim().min(4).max(30).optional(),details:z.string().trim().max(2000).optional(),reservationExpiresAt:z.string().datetime().optional()}).parse(req.body);
    if(action==='allocation' && (!body.studentReference||!body.hostel||!body.room||!body.bed)) return res.status(400).json({message:'A student reference, hostel, room, and bed are required for an allocation request.'});
    if(action==='reservation' && (!body.studentReference||!body.reservationExpiresAt||new Date(body.reservationExpiresAt).getTime()<=Date.now())) return res.status(400).json({message:'A student reference and future reservation expiry are required.'});
    const record=await RecordModel.create({module:'hostel-workflow',title:body.title,status:action==='allocation'?'PENDING_PAYMENT_OR_VERIFICATION':action==='reservation'?'TEMPORARY_RESERVATION':'OPEN',reference:`${action}:${body.session||'unspecified'}:${new mongoose.Types.ObjectId().toString()}`,data:{action,...body,createdBy:req.user!.id,createdAt:new Date().toISOString(),requiresCapacityValidation:true},createdBy:req.user!.id,updatedBy:req.user!.id});
    await audit(req,'HOSTEL_WORKFLOW_RECORDED','hostel-workflow',record.id,{action,studentReference:body.studentReference||null});
    res.status(201).json({record,message:'Hostel workflow record created. Before confirming allocation, the owning workflow must verify payment, bed availability, and concurrency.'});
  }catch(e){next(e);}
});

// Engines produce explainable findings only. They must never autonomously hire, reject, withdraw,
// promote, defer, or graduate a person.
router.post('/engines/:engine/evaluate', allowRoles('REGISTRAR','LECTURER_HOD'), async (req,res,next) => {
  try {
    const engine=z.enum(['recruitment','progression','graduation','eligibility','capacity-reconciliation']).parse(req.params.engine);
    const body=z.object({title:z.string().trim().min(2).max(180),session:z.string().trim().min(4).max(30).optional(),subjectReference:z.string().trim().max(120).optional(),inputs:z.record(z.string(),z.unknown()),policyVersion:z.string().trim().min(1).max(100),requestedChecks:z.array(z.string().trim().min(1).max(100)).max(50).default([])}).parse(req.body);
    const result={engine,policyVersion:body.policyVersion,inputs:body.inputs,requestedChecks:body.requestedChecks,findings:[] as Array<{code:string;severity:'INFO'|'REVIEW_REQUIRED';message:string}>,evaluatedAt:new Date().toISOString(),evaluatedBy:req.user!.id,decisionMade:false,requiresHumanReview:true};
    if(engine==='recruitment') result.findings.push({code:'HUMAN_PANEL_REQUIRED',severity:'REVIEW_REQUIRED',message:'Candidate evidence may be organized for comparison, but appointment or rejection requires the authorized human decision process.'});
    if(engine==='progression') result.findings.push(...evaluateProgression(body.inputs));
    if(engine==='graduation') result.findings.push(...evaluateGraduation(body.inputs));
    if(engine==='eligibility') result.findings.push({code:'ELIGIBILITY_NOT_AUTOMATIC',severity:'REVIEW_REQUIRED',message:'Eligibility must be assessed against configured, versioned institutional rules; no cutoff is invented.'});
    if(engine==='capacity-reconciliation') result.findings.push(...evaluateCapacity(body.inputs));
    const record=await RecordModel.create({module:'system-engine-evaluation',title:body.title,status:'REVIEW_REQUIRED',reference:`${engine}:${body.session||'unspecified'}:${new mongoose.Types.ObjectId().toString()}`,data:{...body,result},createdBy:req.user!.id,updatedBy:req.user!.id});
    await audit(req,'SYSTEM_ENGINE_EVALUATED','system-engine-evaluation',record.id,{engine,policyVersion:body.policyVersion,decisionMade:false});
    res.status(201).json({record,result,message:'Evaluation findings recorded. No hiring, admission, progression, withdrawal, or graduation decision was made automatically.'});
  }catch(e){next(e);}
});

export default router;

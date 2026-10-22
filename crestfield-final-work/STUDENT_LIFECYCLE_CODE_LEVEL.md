# Crestfield University — Student Lifecycle Code-Level Completion

## Lifecycle roles

1. **Applicant** — uses the existing Admissions portal; cannot submit active student requests. The account changes to Admitted Student only when the applicant explicitly accepts an unexpired offer, in the same database transaction as the offer decision.
2. **Admitted Student** — can submit the one-time matriculation request once the Registrar enables that academic session and configures the student's department code.
3. **Registered Student** — receives the matriculation number only after Registrar approval and can request course registration, academic-record services, progression review, deferment, attendance appeal, and graduation clearance.
4. **Graduated Student** — can request academic records and alumni records, but cannot submit active registration or progression requests.

## Integrated frontend and backend

- `client/src/App.tsx`: stage-specific student forms, role-aware options, request status list, Registrar review actions, and matriculation policy editor.
- `server/src/routes/workflows.ts`: stage-specific authorization and validation, student overview, duplicate request controls, Registrar-only reasoned decisions, session-gated matriculation issuance, approved-catalogue course registration, unit-owned clearance submissions, clearance decisions, notifications, and graduation transition guards.
- `server/src/routes/registrar.ts`: audited read/write endpoints for the matriculation policy; saving policy changes preserves the issued-number sequence counters.
- `server/src/routes/records.ts`: student-owned records are scoped to the authenticated student's own account; generic record editing cannot finalize student academic, workflow, or graduation outcomes.
- `server/src/models/User.ts`: uses the established lifecycle role values and unique matriculation-number field.

## Important safeguards

- Student-provided data never directly changes a user's official lifecycle role.
- A matriculation request is one-time and requires explicit global and session enablement plus a department code.
- Number format is `YY/DEPARTMENTCODE/NNNN`; the year prefix is derived from the requested academic session, and issuance updates a shared transactional sequence counter while the unique user index remains the final duplicate guard.
- Course registration requires an assigned matriculation number, an approved Registrar course catalogue, department/faculty compatibility when configured, unique course codes, and no duplicate active request for the same session/semester. The approved catalogue is rechecked when the Registrar approves the registration.
- Student overview reports CGPA only from official published academic records that explicitly provide numeric grade points and credits; it does not invent a grading scale. Attendance summaries report available attendance records but do not autonomously decide exam eligibility. Retake and exam-eligibility workflows are requests for authorized review.
- Registrar decisions require a reason and are audited. Matriculation issuance and graduation role transition are performed in database transactions.
- Graduation cannot be approved based on student-entered clearance claims. Authorized academic, finance, library, and department units submit clearance records; the Registrar separately approves them, and four independently approved records for the same student and graduation session are required.
- No GPA, credit, attendance, or progression cutoff is invented. Progression review is a review request until the university's approved rules are connected.

## Configuration shape

Registrar configures `SystemSetting` key `matriculation` through the connected Registrar interface. Example values:

```json
{
  "enabled": true,
  "departmentCodes": { "Computer Science": "CSC", "Electrical Engineering": "EEE" },
  "sessions": { "2026/2027": { "enabled": true }, "2027/2028": { "enabled": false } }
}
```

The department keys must match `User.department` values exactly. Requests are accepted only when the global flag and the matching session flag are both `true`.

## Remaining institutional dependencies (not fabricated by this module)

This module connects the student lifecycle, registration requests, academic-record requests, progression reviews, deferment/attendance appeals, and independent graduation clearance decisions. It intentionally does not invent GPA/credit/attendance cutoffs or pretend that a course-registration request itself computes results. The university must maintain its approved course catalogue and connect the official fee ledger, attendance register, and results engine before those underlying domain calculations can be represented as complete.


## Matriculation generation gate (updated)

- Students do not submit a matriculation-number request and the student workflow no longer exposes a matriculation-request stage.
- When an admission offer is accepted, the user's `admissionSession` is stored from the accepted application. Existing admitted accounts can resolve the session from their accepted application if the field predates this change.
- The Registrar configures department codes and sessions, then uses the per-session **Allow admitted students to generate** control. This toggle is persisted immediately and audited.
- Only an `ADMITTED_STUDENT` with no matriculation number, an enabled global policy, an enabled switch for their own `admissionSession`, and a configured department code is eligible to see the Generate matriculation number button.
- Generation is a direct, transactional, one-time operation. It creates `YY/DEPARTMENTCODE/NNNN`, moves the account to `REGISTERED_STUDENT`, records an audit event, and the frontend refreshes to the registered-student interface.
- Registered and graduated students cannot generate another number; backend authorization enforces this regardless of frontend visibility.

## Additional student completion pass

- Added a Registrar-owned, versioned `student-academic-policy` setting and frontend editor. It explicitly configures session registration windows, level-based credit limits, grading bands, progression thresholds, department graduation thresholds, attendance threshold, and retake treatment. No institution-specific values are hard-coded.
- Course-registration submissions now require a configured policy and enabled session window, an approved course catalogue, matching department/faculty, configured level credit limits, positive course credits, session/semester offering checks, and prerequisite evidence from official published results. Duplicate active registration requests remain blocked.
- Registrar approval rechecks that the registration session is still enabled and inside its configured window, plus that requested courses remain in the approved catalogue.
- Progression and examination-eligibility requests record policy-versioned evaluations from official records but still require human review; they do not independently change academic standing or exam eligibility.
- Retake requests require an official published failed result for every requested course.
- Student overview now reports term GPA and CGPA from official published result records and applies the configured retake policy. If retake treatment is `MANUAL_REVIEW` and multiple attempts exist, CGPA is withheld rather than silently double-counting attempts.
- Graduation approval now requires department-specific configured minimum passed credits and minimum CGPA from official published results, as well as the four independently submitted and approved clearance types. Registrar authorization remains required for the role transition.
- The student frontend's existing JSX syntax issues were corrected while integrating the policy editor.

## Institution setup dependency

The Registrar must enter Crestfield's approved academic rules into the Student Academic Policy screen before the related checks can permit registration/progression/graduation. This is intentional: the code does not invent credit loads, grading scale, registration dates, attendance minimums, or graduation thresholds.


## Application + student source-audit hardening pass

- O'Level result uploads accept up to two files/sittings while still treating O'Level as one required document category. Staff can retrieve each file independently through short-lived authenticated download links.
- Application email must match the authenticated applicant account at submission and when correcting the application.
- Atomic payment claiming rechecks the configured session and application-fee amount at claim time.
- The application register reports the number of required document categories separately from total uploaded files.
- Static syntax transpilation passed for 60 TypeScript/TSX files. Dependencies were not installed and the app was not run; this is not runtime certification.

# University Management System (UMS)

A modular-monolith university portal starter built with React + TypeScript + Vite + Tailwind + Lucide + React Router, and Node.js + Express + TypeScript + MongoDB/Mongoose.

## Included
- Role-based access: Super Admin, Registrar, Bursary, Hostel Administrator, Admission Officer, Lecturer/HOD, Applicant, Student.
- UTME-only admissions workflow (Direct Entry is intentionally excluded).
- Applicant registration/application submission and status tracking.
- Admin dashboard and module navigation for admissions, staff recruitment, academics/results, finance, accommodation, graduation, communications, reports, audit and settings.
- API authentication with JWT, password hashing, RBAC middleware, validation, centralized error handling, audit events, notification records.
- Dedicated service boundaries for email, private files, PDF generation, Paystack payment verification, notifications, background jobs and reporting.
- MongoDB models and seed script for an initial Super Admin account.
- Responsive UI, API health endpoint, setup guide, and `.env.example`.

## Important
This is a functional foundation and workflow MVP, not a production-certified university ERP. External services (MongoDB, email provider, Paystack, file storage) require credentials/configuration. Payment verification is server-side; do not treat a browser redirect as proof of payment. Review security, data protection, institutional policies, and test thoroughly before production use.

## Requirements
- Node.js 20+
- npm 10+
- MongoDB local instance or MongoDB Atlas

## Setup
1. Extract the ZIP and open this folder in VS Code.
2. Copy `server/.env.example` to `server/.env` and set `MONGODB_URI` and `JWT_SECRET`.
3. Install dependencies:
   ```bash
   npm install
   npm run install:all
   ```
4. Seed the initial administrator:
   ```bash
   npm run seed
   ```
   Default seed login is printed by the script. Change the password immediately.
5. Start client and server:
   ```bash
   npm run dev
   ```
   Client: http://localhost:5173  
   API: http://localhost:4000/api/health

## Environment
See `server/.env.example`. The frontend uses `VITE_API_URL` (defaults to `http://localhost:4000/api`).

## API outline
- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/dashboard`
- `GET|POST /api/applications`
- `PATCH /api/applications/:id/status`
- `GET|POST /api/records/:module`
- `GET|POST|PATCH /api/records/:module/:id`
- `GET /api/audit`
- `GET /api/notifications`
- `POST /api/payments/initialize`
- `POST /api/payments/verify/:reference`

Generic records are permission-gated by module. Critical flows should be extended with institution-specific rules before production.


## Role-owned frontend structure

`client/src/roles/` contains separate folders for Super Admin, Registrar, Admission Officer, Bursary, Hostel Administrator, Lecturer, HOD scope, Applicant, Admitted Student, Registered Student, and Graduated Student. Shared components are in `client/src/shared/`. Server domain boundaries are documented under `server/src/modules/` and decision engines under `server/src/engines/`.

## Profile pictures and preferences

- Users can replace their profile picture repeatedly from **avatar menu → My profile**.
- Supported formats: JPG, PNG and WebP; max 5 MB per upload.
- The backend uploads the new image to Cloudinary first, saves the new URL/public ID in MongoDB, and then deletes the previous Cloudinary asset. If the new upload or database save fails, the previous picture is retained.
- Cloudinary credentials are server-only and belong in `server/.env`.
- **Avatar menu → Settings & preferences** contains light/dark/device theme and email/in-app-only notification preferences. The email helper checks the stored preference server-side.

## Important implementation status

This ZIP is an actively developed foundation, not a claim that every university workflow is production-complete. Existing routes and record CRUD are not substitutes for the full approved admissions, hiring, financial, academic, hostel, and graduation workflows. Domain-specific modules and engine folders identify where those workflows belong. Before a live launch, implement and test each workflow, apply server-side role permissions to every mutation, configure providers, and complete security and concurrency testing. No production credentials are included.


## Phase 1 implementation update (foundation and identity)

The current Phase 1 code includes:

- Protected Super Admin staff-account API (`GET/POST /api/users`, `PATCH /api/users/:id/status`, and `POST /api/users/:id/reset-password`).
- A Super Admin-only User Administration screen for creating initial staff accounts, suspending/reactivating accounts, and resetting passwords.
- Initial non-lecturer staff accounts are created as `PENDING`; a single-use activation link is emailed to the invitee, who sets their own password. Only a SHA-256 hash of the activation token is stored, and the link expires after 24 hours. Staff invitation and password-reset email delivery require SMTP configuration. Account deletion is intentionally not offered for active historical records so academic/financial attribution is preserved.
- Optional one-time bootstrap Super Admin using `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD`. Set a unique password of at least 14 characters. The bootstrap does nothing after a Super Admin already exists. Remove the password from the environment after initial setup.
- Production startup refuses an absent/short `JWT_SECRET`; health endpoint reports database connectivity.
- Expanded role enum includes distinct lifecycle roles for admitted, registered and graduated students and a lecturer role. `LECTURER_HOD` and `STUDENT` remain as compatibility values for existing accounts; HOD should ultimately be migrated to an appointment/scope on a lecturer account, and student lifecycle migration must be completed before production data is imported.

### Phase 1 verification status

The source changes are included, but a successful TypeScript/Vite build and database-backed integration test have not yet been verified in this environment. Configure `.env` values and run `npm install`, `npm run build`, and `npm test` before deployment. This project is not yet production-ready; later implementation phases still need to complete the admissions, academic, finance, hostel, recruitment and graduation workflows.

## Super Admin implementation update (21 Oct 2026)

The Super Admin console now has dedicated frontend screens and protected API endpoints for:

- Overview metrics: account counts, role distribution, database state, recent audit activity, and 24-hour audit-event count.
- Staff account lifecycle: create supported staff roles, list/search accounts, suspend/reactivate accounts, reset credentials, and change a managed staff account's role. Super Admin self-suspension and self-role changes are blocked; accounts are suspended rather than deleted.
- Audit trail: server-side search, action filtering, pagination, and read-only event display.
- Operational settings: persisted general settings in MongoDB with an audit event when saved.
- System health: API/database status and presence checks for configured integration environment variables. These checks do not validate third-party credentials.
- Super Admin UI navigation is separated from operational academic/admissions/finance modules. The backend continues to enforce Super Admin-only access to the admin endpoints.

### Important implementation boundary

The general settings screen currently persists configuration values, but flags such as maintenance mode, applicant-registration enablement, and the announcement delivery preference are **not yet enforced across every dependent workflow**. They must not be treated as production controls until enforcement middleware/services are wired and tested. External provider connectivity is not end-to-end verified. No successful build or automated test run is claimed because npm dependency installation repeatedly timed out in this environment.


## Super Admin completion pass (21 Oct 2026)

This update keeps the whole application in one project ZIP; **do not copy/paste these files manually into another project**. The Super Admin implementation spans separate files intentionally because routes, database models, authentication middleware, and UI have different responsibilities. They are already wired together in this project.

Additional changes in this pass:

- Account listing now supports server-side search, role/status filters, and pagination.
- User administration UI includes filters, pagination, password-reset confirmation, session revocation, and one-time temporary-password display/copy.
- Session revocation increments a per-user token version, causing previously issued JWTs for that account to be rejected on their next request. Password reset also revokes existing sessions.
- Super Admin accounts cannot be suspended, reset, or have their role changed through ordinary staff account actions. A dedicated recovery process is still needed for Super Admin account recovery.
- Failed and blocked login attempts are recorded as security audit events. Login endpoints are rate-limited.
- Audit screen supports text/action/date filters and pagination.
- Applicant registration setting is enforced at account registration. Maintenance mode blocks API modules for non-Super-Admin users while leaving health and authentication endpoints available so administrators can sign in. The gate is installed centrally before protected API modules.

## Verification note

The source archive was checked for ZIP integrity. A successful TypeScript/Vite build and live MongoDB-backed integration test could not be completed because npm dependency installation timed out in this environment. Therefore, the code is delivered as an integrated source update, but it must not be described as build-verified or production-ready. Run `npm install` at the project root, then `npm run build` in both `server` and `client`, and fix any environment-specific issues before deployment.


## Registrar implementation (integrated code-level pass)

The Registrar has a dedicated role-restricted workspace at `/registrar` and API namespace `/api/registrar`. The workspace covers faculty, department, programme and course records; academic calendars and policies; HOD appointment/revocation records; final lecturer recruitment decisions following HOD recommendation; result approval/publication decision records; deferment decisions; official student-record entries; announcements and reports. Draft creation, filtering/search, status-aware decision transitions, required written reasons, and audit events are included. The Registrar API is restricted to the `REGISTRAR` role; Super Admin remains a technical administrator and does not receive this decision authority.

Registrar records are stored in the shared MongoDB `Record` collection with `module: registrar`, preserving the existing project structure. The dedicated page and API are integrated into the existing application rather than delivered as disconnected snippets. The Registrar decision records are workflow records: they do not automatically synchronize every decision into the application status, official results engine, student progression engine, external email delivery, or deferment submission records. Those underlying domain integrations require their own canonical models and transaction-safe workflows before the related end-to-end processes can be represented as fully operational. This archive is a code-level deliverable; dependencies/build/runtime tests have not been run per the requested instruction.

## Registrar implementation (integrated code-level scope)

The Registrar workspace is included in the same application as Super Admin; it is not a separate app or a set of files that must be manually merged. Its frontend route is `/registrar`, and its API is mounted at `/api/registrar`. Every route is protected by authentication and the `REGISTRAR` role.

Included Registrar capabilities:
- Create, search, filter, and maintain institutional records for faculties, departments, programmes, courses, academic calendars, academic policies, HOD appointments, lecturer recruitment decisions, result approvals, deferment decisions, student records, announcements, and reports.
- Server-side pagination, status/category filtering, duplicate reference protection, input validation, and draft-first record creation.
- Explicit submission to formal review for recruitment/result/deferment/student-record/report items.
- Category-specific permitted decision outcomes; required reason; previous status, actor, timestamp, and decision-policy version recorded in decision history; audit event for creation, updates, submissions, and decisions.
- Approved HOD appointment/revocation updates the HOD appointment flag and role on the existing lecturer account. HOD is not created as a separate base identity.
- Finalized records cannot have their status changed through the ordinary edit route. Status changes must use submission or decision endpoints.
- Registrar role boundary is enforced server-side; Super Admin's technical administration and Registrar's academic/institutional authority remain separate.

This archive is delivered as a code-level implementation as requested; dependency installation and application execution were intentionally not performed. The Registrar workspace uses the project's shared institutional `Record` collection for its domain records. Where a future role's canonical workflow owns an operation (for example, a lecturer's teaching-result submission or a student's deferment request), this Registrar workspace does not impersonate that role or fabricate that upstream submission; it handles Registrar-owned records and decisions with the role boundary preserved.

## Registrar end-to-end decision integration (code-level)

The Registrar workspace is integrated into the same application (`/registrar`) and its role-protected API (`/api/registrar`). Registrar-created records begin as drafts; official outcomes must pass through the audited decision endpoint. Finalized Registrar records are immutable through ordinary edits so their decision history cannot be silently overwritten.

For cross-module final decisions, create the Registrar decision record with `linkedRecordId` in its structured metadata, pointing to the existing canonical record in the owning module:

- `lecturer-recruitment-decision` → `recruitment` module record. Submit it after the HOD/panel recommendation is represented in that canonical record. Registrar approval/rejection updates the canonical recruitment status and stores the decision and history there.
- `result-approval` → `academics` module record representing the result. Set `kind` to `result`, `course-result`, or `assessment-result` when the record includes a `kind` discriminator. Registrar `APPROVED`, `PUBLISHED`, or `REJECTED` is propagated to the canonical record and audited.
- `deferment-decision` → `workflows` module record representing the deferment request. Set `kind` to `deferment` or `deferment-request` when using a `kind` discriminator. The final Registrar decision is propagated to the canonical request and audited.

Submission validates the linked record exists in the expected module; final decisions revalidate the link and allowed source status. Cross-module decision data is recorded in both the Registrar decision record and canonical record, including actor, reason, timestamp, source decision record, policy version, and history. These code-level integrations have not been runtime-tested, and they do not imply a tested MongoDB transaction across both documents. Before production use, verify the deployed MongoDB Atlas topology and add transaction/compensation handling for cross-document writes if required.

Other Registrar responsibilities remain deliberately scoped: HOD is an appointment on an existing active lecturer account (not a separate user identity); the Registrar records final lecturer hiring decisions after recommendation; result publication and student status transitions must not be made through generic record edits. The Registrar role cannot change Super Admin technical settings or grant itself higher privileges.

## Registrar integration — code-level completion pass

The Registrar workspace is integrated into the same React application and Express API as the Super Admin foundation. Registrar API routes are mounted at `/api/registrar` and protected by `authenticate` plus `allowRoles('REGISTRAR')`; the client route is role-gated as well. The Registrar can manage institutional structure and policy records, submit applicable records for review, record formal decisions with reasons, and inspect decision history.

### Cross-module decision contract

- Lecturer recruitment final decisions require a linked canonical `recruitment` record and propagate the Registrar outcome plus decision metadata/history to that record.
- Result decisions require a linked canonical `academics` record explicitly marked with `data.kind` equal to `result`, `course-result`, or `assessment-result`; the outcome and decision trail are written to both records.
- Deferment decisions require a linked canonical `workflows` record explicitly marked with `data.kind` equal to `deferment` or `deferment-request`; the outcome and decision trail are written to both records.
- HOD appointment/revocation acts on an existing lecturer account; HOD is an appointment flag/role scope on that account, not a separately created identity.
- Generic module CRUD now blocks Registrar from creating or editing canonical recruitment, academic-result, and workflow records. Final Registrar outcomes must go through the audited decision endpoint.
- Institutional references are checked before mutation, and decision records retain outcome, reason, actor, timestamp, previous status, and policy version.

### Important scope boundary

This is code-level integration only. No dependency installation, build, runtime, database, or end-to-end verification has been performed for this archive. Cross-document updates are sequential MongoDB writes, not a MongoDB multi-document transaction; production use must add transaction handling (and test it against the deployed MongoDB topology) before treating cross-module decisions as failure-atomic. The generic `RecordModel` remains the current shared workflow-record abstraction; dedicated domain schemas and complete end-to-end workflow implementations for other roles are separate implementation work, not implied by the Registrar UI.

## Admission Officer implementation
The Admission Officer workflow is integrated into the shared application routes and UI. See `client/src/roles/admission-officer/README.md` for role boundaries, required configuration, private document handling, notification events, and endpoint map. Registrar configures admission policy through the Registrar workspace. No default application fee or UTME cutoff is invented; session fee, deadline, required documents, programme capacities, and screening rules version must be configured by an authorized Registrar.

Email delivery uses Nodemailer and requires `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM`. Applicant documents require authenticated Cloudinary storage and are served only through audited short-lived signed URLs.


## Admission Officer code-level completion pass (21 Oct 2026)

The Admission Officer workflow is implemented in the shared application, not as a disconnected role app. The active frontend is `Admissions` in `client/src/App.tsx` at `/admissions`; role notes and endpoint contracts are maintained in `client/src/roles/admission-officer/README.md`. The backend is mounted at `/api/applications`, with server-side role checks.

The integrated workflow covers UTME-only application submission (no drafts and one application per applicant/session), required-document validation, private authenticated Cloudinary storage and audited short-lived document links, server-verified Paystack fees, application review and clarification, explicit eligibility assessment without invented score cutoffs, screening batches, primary/alternative offers, consent/deadline handling, decision history, in-app notifications, and the four specified admission email events. Registrar-configured session settings, fee, deadline, required documents, screening-policy version and programme capacities are read from the shared configuration records.

Additional hardening in this pass: malformed required-document configuration falls back to the complete default checklist rather than disabling validation; payment references are claimed with a conditional atomic database update before an application is committed, preventing concurrent double-use; application documents use Mongoose optimistic concurrency to reject conflicting simultaneous edits; screening-batch claims recheck current eligibility/payment/status and idempotency keys cannot be reused across sessions; alternative programme capacity is updated from current Registrar configuration before an atomic seat reservation; rejected terminal decisions release alternative reservations only after the application record saves; and notification-provider failures no longer turn a successfully committed workflow action into an apparent failed request. A signed Paystack `charge.success` webhook endpoint is also available at `POST /api/payments/webhook`; it validates the HMAC signature over the exact raw request bytes, checks NGN amount against the stored fee, and applies a conditional idempotent status transition.

### Honest delivery boundary

This is a code-level integration pass as requested. Dependencies were not installed and the application was not run. No claim is made that compilation, live provider connectivity, MongoDB concurrency behavior, or end-to-end scenarios have been runtime-verified. Before production, test all workflows and provider callbacks against the configured MongoDB Atlas topology and Paystack test environment, including compensation/reconciliation for rare failures between capacity reservation updates and offer-record writes. Do not commit secrets; use the server environment for Paystack, Cloudinary and SMTP credentials.


## Admission Officer integration pass (21 Oct 2026)

The integrated admissions workflow in `server/src/routes/applications.ts` and the Admissions workspace in `client/src/App.tsx` cover the following code-level paths:

- UTME-only application creation, required-document checklist, one application per applicant/session, and a unique session/JAMB registration number constraint.
- Server-side application fee initialization and verification. Fee verification uses conditional MongoDB updates and dot-path data changes so it does not overwrite a concurrent application claim. Paystack webhooks validate the HMAC signature, amount and currency.
- Private authenticated Cloudinary document uploads, short-lived private download links, MIME restrictions (birth/citizenship certificates are PDF-only), and durable cleanup jobs for replaced/orphaned assets.
- Application search, pagination, status/eligibility/payment filters, and an Admission Officer “assigned to me” view.
- Assignment to self for unassigned cases, review notes, clarification requests, explicit eligibility decisions, document readiness, and human-recorded decisions. No score cutoff or autonomous admission outcome is invented.
- Screening batches with the 100-application threshold rule, a stable client idempotency key, batch audit history, and recovery endpoint for interrupted/failed batches. A screening batch does not itself admit or reject applicants.
- Primary and alternative offers with explicit eligibility evidence, acceptance deadline, seat-capacity checks, and applicant consent. Capacity updates use conditional atomic increments; recovery from a process crash between multiple MongoDB writes still needs replica-set transactions or a reconciliation job before production certification.
- The four defined admission email event types are queued with stable event keys, preference checks, retry/backoff, and abandoned-worker recovery. SMTP delivery is at-least-once: a process crash after an email provider accepts a message but before the database marks it sent can still cause a duplicate. Email and in-app delivery are not guaranteed until provider configuration and live delivery tests are completed.
- Server-side role and assignment checks, audit events for workflow mutations and secure document access, and a responsive staff workflow with visible review notes and recent decision history.

### Admission workflow verification boundary

These are source-level changes. Dependencies were not installed and the application was not started or built in this pass, as requested. Therefore TypeScript compilation, browser behavior, MongoDB index creation against existing data, Paystack/Cloudinary/SMTP connectivity, concurrent-request behavior, and end-to-end delivery remain unverified. Before production use, back up the database before enabling the new unique `{ utmeNumber, session }` index, because pre-existing duplicate records would prevent index creation. Use a MongoDB replica set and transactions (or a durable saga/reconciliation process) for fully atomic cross-document capacity/offer updates.

## Integrated workflow coverage (code-level)

### Admission Officer
- UTME application workflow with required-document checks, private upload handling, clarification, assignment, readiness review, versioned screening batches, decisions, primary/alternative offers, applicant consent, and decision/audit history.
- Screening batch creation now claims the selected eligible applications and creates/completes the batch in one MongoDB transaction. The operation uses a stable idempotency key and retains human review; it does not auto-admit or auto-reject.
- Primary and alternative offer creation now reserve configured programme capacity in the same transaction as the application offer/decision update. Applicant acceptance/decline/expiry updates offer statuses and releases reservations for offers that are no longer active.
- Admission workflows use the configured, versioned institutional eligibility rules; the application does not invent scoring cutoffs.
- Applicant-facing admission email events remain limited to application assigned, clarification requested, ready for review, and decision pending; other updates remain in-app notifications.

### Student lifecycle workbench
- Four request/review stages: course registration, academic records, progression review, and graduation clearance.
- Student submissions are requests/evidence only. They do not silently change official registration, progression, deferment, or graduation status.

### Lecturer workbench
- Two stages: course assignment records and assessment/result submissions.
- Submissions remain under review; they do not self-assign a lecturer, publish official results, or bypass Registrar approval.

### Hostel workbench
- Room/bed inventory records, maintenance, temporary reservations, allocation requests, and checkout records.
- Allocation requests require student, hostel, room, and bed identifiers; reservation requests require a future expiry. These records explicitly remain pending validation until the owning allocation workflow confirms payment, bed availability, and concurrency.

### System engines
- Recruitment, progression, graduation, eligibility, and capacity-reconciliation evaluations produce policy-versioned findings and human-review flags only. They do not autonomously hire, reject, withdraw, promote, or graduate anyone.

### Important implementation boundary
- Cross-document writes use MongoDB transactions where the workflow requires them; the deployment database must support transactions. The code has not been independently certified against a live institutional dataset, and institution-specific rules/capacities must be configured by authorized staff before operational use.

## Student lifecycle workflow (integrated code-level implementation)

The student journey is separated by institutional status: **Applicant** remains in the Admissions portal; accepting a valid offer changes the account to **Admitted Student** in the same transaction as the offer decision; Registrar-approved matriculation issuance moves the account to **Registered Student**; and Registrar-approved graduation clearance moves the account to **Graduated Student**. A student request alone never changes official status.

- `POST /api/workflows/student/matriculation-request`: one-time student-initiated request, session-gated by Registrar configuration and department code.
- `POST /api/workflows/student/course-registration`: requires a matriculation number, session, semester, and unique course codes; duplicate active requests for the same session/semester are rejected.
- `POST /api/workflows/student/academic-records`: requests academic records/transcript services.
- `POST /api/workflows/student/progression-review`: requests a progression review; no invented GPA/credit threshold is applied.
- `POST /api/workflows/student/deferment-request` and `/attendance-appeal`: require a reason and await authorized review.
- `POST /api/workflows/student/graduation-clearance`: requests clearance for a named graduation session; approval is blocked until independently approved academic, finance, library, and department clearance records exist.
- `POST /api/workflows/student/alumni-record-request`: available to graduated students for post-graduation records.
- `POST /api/workflows/student/:recordId/decision`: Registrar-only, reasoned and audited review. Matriculation issuance and graduation transition use MongoDB transactions so the canonical request and user role are updated together.
- `GET/PUT /api/registrar/matriculation-config`: Registrar configures global enablement, department codes, and explicit per-session enablement. Codes are matched against the student's department field and generated matriculation numbers follow `YY/DEPARTMENTCODE/NNNN`.

The student lifecycle page is connected to these endpoints and displays the user's own requests; the Registrar view supports decisions and matriculation-policy configuration. Applicant accounts continue to use the Admissions portal rather than student lifecycle actions. Academic progression policy, result computation, and official fee/attendance integrations remain owned by their institutional workflows; this module deliberately does not invent thresholds. Unit-submitted academic, finance, library, and department clearance records are now created and approved through a dedicated, audited clearance workflow rather than generic record editing.

## Hostel Administrator module (integrated)

See `HOSTEL_MODULE_IMPLEMENTATION.md` for the finalized fee approval and booking workflow. Hostel fees follow Hostel Administrator proposal → Bursary review/forwarding → Registrar final decision → Bursary communicates the decision → Hostel Administrator publishes. Published listings and approved prices are visible to students while booking remains disabled until the Hostel Administrator activates it. The module includes 2–3 Cloudinary-hosted photos, session-based 60-minute reservations, server-side Paystack verification, capacity guards, violation restrictions, notifications, and audit events.

## Lecturer Recruitment, Lecturer/HOD and Attendance Integration

The integrated build now includes a dedicated `/api/lecturers` workflow and frontend workspaces for the finalized recruitment stages: Registrar-authorized vacancy creation, Super Admin publication, applicant submission, Super Admin administrative checks, department-scoped HOD recommendation, Registrar final hiring decision, candidate offer acceptance, and one-time self-service Staff ID generation. Lecturer/HOD course and result submissions are connected to departmental review; a HOD result recommendation creates a canonical academic result record and Registrar final-approval item. Lecturer attendance is limited to approved course assignments, and registered students can view their own attendance at `/my-attendance`. HOD and Registrar do not have routine attendance-monitoring dashboards.

See `LECTURER_HOD_INTEGRATION.md` for route inventory, role boundaries, and verification limitations.


### Lecturer module completion pass

The Lecturer/HOD workflow includes Cloudinary-backed private recruitment documents (MongoDB metadata only), one-time Staff ID generation, course assignment proposals, assessment/result submissions for HOD and Registrar review, private Cloudinary PDF course materials for assigned courses, lecturer-only attendance recording, and student attendance/material access scoped to registered courses. See `LECTURER_HOD_INTEGRATION.md` for the role boundaries and verification limitations.

## Lecturer module implementation notes

- **LECTURER_NEW_COURSE_PROPOSAL.md** — lecturer recruitment, academic workflow and new-course proposal implementation notes.

## Lecturer module audit

See `LECTURER_MODULE_COMPLETION_AUDIT.md` for the code-level review, fixes, static-check results, and the runtime verification that remains outstanding.

## Public homepage and stage-based sign-in

The public entry screen is a universal Crestfield University homepage describing the university's educational purpose, values, research, community contribution, and campus services. The sign-in screen supports the current-stage identifier policy:

- Applicants who have not submitted a UTME application use their email and the password created during registration.
- Once a UTME application exists, the applicant/student signs in with the JAMB/UTME registration number and the existing password until matriculation.
- After the Registrar-authorized workflow allows matriculation and the student generates a matriculation number, only that matriculation number is accepted as the login identifier. The existing password is retained for that first sign-in, and `mustChangePassword` is set so the user is required to change it.
- Lecturer candidates use email and the password created during their recruitment application until their approved offer has been accepted. The system generates the Staff ID atomically during offer acceptance; after that, only the Staff ID is accepted as the login identifier. The candidate must change the existing password at first lecturer sign-in.
- Initial Registrar, Bursary, Hostel Administrator and Admission Officer accounts use the emailed activation link to set their own password, then sign in with their work email. Generic staff management cannot create lecturer accounts or change a lecturer into another staff role.
- For initial lecturer recruitment, the Registrar can record an explicit bootstrap review only when the vacancy is marked for initial recruitment and no active appointed HOD exists. The Registrar's final hiring decision remains a separate step.

The API enforces the identifier transition; changing the visible login field alone is not the security control. `server/.env.example` and `client/.env.example` explain every environment setting immediately above the setting.

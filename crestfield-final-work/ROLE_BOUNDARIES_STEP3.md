# Step 3 — Role-specific portal boundaries and permissions

## Source changes made

- Restricted generic `/api/records/:module` access to explicit module-role grants. `SUPER_ADMIN` is no longer granted access to academic, finance, accommodation, graduation, communications, reports, university structure, student workflow, lecturer workflow, hostel workflow, or institutional workflow records.
- Kept Super Admin technical functions on dedicated routes: account administration (`/api/users`), technical settings/health (`/api/admin`), and read-only audit access (`/api/audit`). The intended recruitment exception remains: Super Admin can publish a vacancy only after Registrar authorization, and can run the technical candidate admin-check; it cannot make HOD or Registrar hiring decisions.
- Removed Super Admin access to lecturer application review queues, candidate-document downloads, staff-ID lists, course-material downloads, finance fee-schedule listings, finance exception records, and policy-engine evaluations.
- Kept the Registrar as the final authority on fee schedules, academic results, course approvals, student lifecycle decisions, graduation, and hiring decisions through the dedicated audited workflows.
- Added explicit frontend route access lists so direct URL entry does not display business workspaces to unauthorized roles. Server authorization remains authoritative.
- Tightened the frontend links for recruitment, lecturer/HOD workflow, system engines, communications, and audit to match the role boundaries.

## Permission boundary summary

| Role | Intended authority |
|---|---|
| Super Admin | User lifecycle and access administration, technical settings/health, audit visibility, vacancy publication after Registrar authorization, technical recruitment admin-check |
| Registrar | Institutional and academic final decisions, official records, university structure, fee schedule decisions, final hiring and graduation decisions |
| Admission Officer | Application screening/review within assigned admissions scope; no Registrar-only institutional decisions |
| Bursary | Fee proposals, payment reconciliation and finance exception investigation; cannot approve its own fee schedule or make academic decisions |
| Hostel Administrator | Hostel proposals, publication and accommodation operations; cannot approve own proposals or change finance/academic outcomes |
| Lecturer | Own assigned teaching, attendance and assessment submission; cannot publish official results or review outside assigned courses |
| HOD scope / legacy HOD role | Department-scoped recommendations and review; cannot make Registrar final decisions |
| Applicant/student lifecycle roles | Own application, student requests and eligible self-service actions; cannot create official approved outcomes or view other users' records |

## Static checks performed

- Inspected the route authorization middleware, record-module allow-list, sensitive finance/lecturer endpoints, client navigation and route guards.
- Confirmed Super Admin is absent from the institutional `moduleRoles` grants and removed from the identified business-sensitive endpoints.
- Confirmed the Registrar's dedicated decision endpoints remain role-restricted.
- Confirmed UI route guards redirect roles that are not allowed to the relevant workspace.

## Limits

This is static source review only. No dependencies were installed and the app, build, database, or runtime authorization tests were not run. Automated authorization tests and runtime checks remain pending the user's prior instruction not to install dependencies or run the application.

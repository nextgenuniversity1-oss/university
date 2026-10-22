# Crestfield University — Lecturer Module Completion Audit

Audit date: 21 October 2026
Scope: source-code inspection and targeted fixes only. Dependencies were not installed and the application was not run, as requested.

## Fixes made during this audit

1. Fixed a frontend TypeScript reference to an undefined `decisionReasons` variable in the Registrar's new-course proposal decision controls. The buttons now consistently read the existing `decisionReason` state.
2. Tightened lecturer-candidate review access: HODs must have an active HOD scope and department, and the review list is department-scoped case-insensitively.
3. Prevented HODs from reviewing a new-course proposal that they personally submitted, both in the review queue and at the backend decision endpoint. Their own proposals remain visible in their own proposal list.
4. Removed terminal `RECOMMENDED` and `NOT_RECOMMENDED` recruitment applications from the HOD action queue so the interface does not offer actions that the backend must reject.
5. Tightened new-course proposal submission so the lecturer/HOD must have an assigned department and may propose only for that department.
6. Corrected Cloudinary cleanup behavior when the MongoDB application/material record was already persisted but a later audit/logging step fails. A successful persisted record is no longer left pointing to an asset that the error handler has just deleted.
7. Tightened student course-material access: no material is listed unless the student has course registrations with session information, and a missing registration session no longer grants access to materials from arbitrary sessions.
8. Updated the frontend TypeScript target/lib to ES2021 because the application uses `String.replaceAll`; ES2020's standard library does not define that method.

## Feature-by-feature source review

| Area | Source review status | Notes |
|---|---|---|
| Vacancy creation and authorization | Present | Registrar creates/authorizes; Super Admin publishes only an authorized vacancy. |
| Public-to-signed-in applicant vacancy list | Present | Vacancy must be published, open, and before closing date. |
| Lecturer applications and document uploads | Present | CV and highest qualification certificate required; professional certificate and identity document optional. PDF/JPEG/PNG MIME, extension-independent signature checks, 8 MB per-file limit. |
| Cloudinary and MongoDB storage | Present | Authenticated Cloudinary assets; MongoDB stores public ID, resource type, delivery type and metadata, not document bytes. Signed temporary download links are issued after authorization. |
| Super Admin administrative check | Present | Not the final hiring authority. |
| HOD candidate review | Present, scope hardened | Departmental review and recommendations; only appointed HODs with scope. |
| Registrar final hiring decision | Present | Requires formal HOD recommendation; approved offers await candidate response. |
| Offer response and account transition | Present | Acceptance uses a MongoDB transaction and changes the same applicant account to Lecturer. Transaction behavior still needs testing against the configured MongoDB deployment. |
| One-time Staff ID generation | Present | Requires accepted offer; checks existing ID and uses a sequence inside a transaction. Runtime concurrency behavior remains untested. |
| HOD appointment | Integration dependency | The Lecturer module consumes the existing `LECTURER_HOD` role, `hodScope`, and department fields. Appointment/revocation must be verified against the Registrar workflow separately. |
| Course-assignment proposal | Present | Separate from proposing a new course. Requires HOD review. |
| New-course proposal | Present | Lecturer/HOD submits; HOD reviews another person's proposal within their department; Registrar makes final decision. Approval creates an approved course-catalogue record, not a teaching assignment. |
| Course materials | Present | PDF-only, signature-checked, private authenticated Cloudinary storage; students must be registered for the course and session to download. |
| Class roster and attendance | Present | Lecturer can access roster and mark attendance only for an approved assigned course. Student attendance route returns their own records. No HOD/Registrar attendance-monitoring endpoint is provided. |
| Assessment/result submissions | Present | Lecturer submissions require HOD review; HOD recommendation creates a Registrar final-review record. Official publication must remain under Registrar workflow. Cross-module end-to-end transition is not runtime-verified. |
| Notifications/audit | Present in source | Many transitions write audit events and in-app/email notifications. Delivery and failure/retry behavior require runtime verification. |
| Frontend integration | Present in source | Dedicated workspace is mounted on `/recruitment` and `/lecturer-workflow`; role-gated sections cover applicant, Super Admin, Registrar, HOD, and Lecturer flows. |

## Static checks performed

- TypeScript/TSX syntax transpilation using the globally available TypeScript compiler API: **63 source files checked, zero syntax diagnostics**.
- ZIP integrity check is to be performed after packaging.
- A full `tsc --noEmit` check was attempted without installing dependencies. It cannot be treated as a successful type-check because the project dependencies and type packages are absent (`react`, `express`, `mongoose`, `@types/node`, etc.); the resulting missing-module/type-environment diagnostics prevent a trustworthy full type-check.
- No dependencies were installed.
- The application was not started and no database, Cloudinary, email, or browser workflows were exercised.

## Outstanding verification (not a claim of source omission)

These checks require the project's normal dependency/runtime environment and are intentionally not performed in this audit:

1. Full TypeScript type-check and frontend production build.
2. API integration tests for each role, including forbidden cross-department and cross-role access.
3. MongoDB transaction/unique-index/concurrency tests for offer acceptance, Staff ID generation, duplicate applications, and duplicate course-code approvals.
4. Live Cloudinary upload/download/cleanup tests for authenticated raw PDF assets and image assets.
5. End-to-end confirmation that Registrar result decisions update the canonical result and publication status exactly once.
6. Notification delivery, retry, and duplicate-notification tests.

## Verdict

The source has been audited and targeted defects found during inspection have been fixed. The Lecturer module has implemented workflows for recruitment, documents, Staff IDs, course assignments, new-course proposals, course materials, attendance, and academic submissions. **It is not honestly possible to certify it as fully verified or production-ready without dependency-backed type-checking and integration/runtime tests.** This limitation is explicit and is not being hidden by calling syntax transpilation a full build.

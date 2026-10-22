# Lecturer New-Course Proposal Workflow

## Purpose
This is distinct from a lecturer's course-assignment request. It lets a lecturer recommend that Crestfield University consider a new course. A proposal never grants teaching rights and is not itself an official course.

## Workflow
1. A Lecturer or appointed Lecturer/HOD submits course title, optional suggested code, department, faculty, level, credit units, description, objectives, rationale, and optional prerequisites.
2. The backend verifies the lecturer account and prevents proposing outside the lecturer's assigned department when that department is set. Suggested codes are checked against the Registrar's official course catalogue.
3. The appointed HOD for that department records `RECOMMEND`, `DO_NOT_RECOMMEND`, or `RETURN_FOR_INFORMATION`, with a required reason. HOD scope is checked on the server.
4. After HOD review, the Registrar records `APPROVE`, `REJECT`, or `RETURN_FOR_INFORMATION`, also with a required reason. The Registrar's decision is final in this workflow.
5. Registrar approval creates a `module: registrar`, `data.category: course` record with `status: APPROVED`, so it integrates with the existing course-registration catalogue check. The official course code is unique through the existing `(module, reference)` unique index and is checked against existing approved catalogue codes before creation.
6. The approved course is not assigned to a lecturer automatically. Teaching assignment remains a separate workflow.
7. Proposal submissions and decisions are audited. The proposer receives an in-app notification and an email-outbox event. Department HODs receive a submission notification.

## API
- `POST /api/lecturers/courses/proposals` — Lecturer / Lecturer HOD submits proposal.
- `GET /api/lecturers/courses/proposals/mine` — Lecturer / Lecturer HOD lists own proposals.
- `GET /api/lecturers/courses/proposals/review` — HOD sees proposals in appointed department; Registrar sees institution-wide proposals.
- `POST /api/lecturers/courses/proposals/:id/hod-review` — appointed HOD records recommendation.
- `POST /api/lecturers/courses/proposals/:id/registrar-decision` — Registrar records final decision and, when approved, creates official catalogue record.

## Boundaries and verification
- Applicants, Super Admin, and other staff roles cannot submit or decide course proposals through these endpoints.
- An HOD cannot make the Registrar's final decision.
- Course proposal approval does not assign teaching or publish official results.
- Static TypeScript/TSX syntax transpilation passed for the modified route and UI component. Dependencies were not installed and the application was not run, as requested; database integration, role-specific runtime flows, email delivery, and full end-to-end behaviour still require runtime verification later.

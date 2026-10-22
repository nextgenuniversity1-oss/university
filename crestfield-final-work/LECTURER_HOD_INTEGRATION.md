# Lecturer Recruitment, Staff ID, HOD and Attendance Integration

## Integrated flow

1. Registrar creates/authorizes a lecturer vacancy (`lecturer-recruitment` record, `AUTHORIZED_FOR_PUBLICATION`).
2. Super Admin publishes only an authorized vacancy (`PUBLISHED`). Published vacancies are visible on the recruitment page while their deadline is open.
3. Applicant submits one application per vacancy. Duplicate applications for the same vacancy are rejected.
4. Super Admin records administrative checks and can request information, shortlist, or mark an application not eligible.
5. An appointed HOD can review only candidates in their appointed department and records a recommendation.
6. Registrar can make the final hiring decision only after the HOD recommendation. Approval creates an offer awaiting candidate response; rejection/return is recorded and audited.
7. Candidate acceptance changes the same account from `APPLICANT` to `LECTURER` and records the accepted offer on the candidate record.
8. An eligible accepted lecturer generates one Staff ID directly. No additional activation is needed. The backend requires a matching accepted recruitment offer, rejects repeat generation, uses a database sequence, stores the ID on the user, audits the event, and notifies relevant HOD/Registrar/Super Admin accounts.
9. HOD remains an appointment on an existing lecturer account. Registrar appointment/revocation updates the lecturer role/scope and department appointment field.
10. Lecturer course/assessment submissions include the account's department. HOD reviews course assignments and result submissions. An HOD result recommendation creates a canonical `academics` result record and a Registrar final-approval record; it does not publish the result.
11. Lecturer attendance is limited to approved course assignments and active registered students. Attendance records are associated with the student account and published for that student's portal.
12. Students have a dedicated `/my-attendance` page that displays course summaries and individual attendance entries. There is no HOD/Registrar attendance-monitoring endpoint or dashboard.

## API routes added

- `GET /api/lecturers/vacancies`
- `POST /api/lecturers/vacancies` (Registrar)
- `GET /api/lecturers/vacancies/admin` (Registrar/Super Admin)
- `POST /api/lecturers/vacancies/:id/publish` (Super Admin)
- `POST /api/lecturers/vacancies/:id/apply` (Applicant)
- `GET /api/lecturers/applications/mine`
- `GET /api/lecturers/applications/review` (Super Admin/HOD/Registrar)
- `POST /api/lecturers/applications/:id/admin-check` (Super Admin)
- `POST /api/lecturers/applications/:id/hod-review` (appointed HOD, department-scoped)
- `POST /api/lecturers/applications/:id/registrar-decision` (Registrar, HOD recommendation required)
- `POST /api/lecturers/applications/:id/offer-response` (candidate)
- `GET /api/lecturers/me/staff-id-access`
- `POST /api/lecturers/me/generate-staff-id`
- `GET /api/lecturers/staff-ids` (department-scoped for HOD; institutional for Registrar/Super Admin)
- `GET /api/lecturers/me/assignments`
- `GET /api/lecturers/academic/review-queue` (appointed HOD)
- `POST /api/lecturers/academic/:id/hod-review` (appointed HOD)
- `GET /api/lecturers/courses/:courseCode/students`
- `POST /api/lecturers/attendance`
- `GET /api/lecturers/attendance/mine` (Student)
- `GET /api/lecturers/attendance/course/:courseCode` (assigned Lecturer)

## Role boundaries

- Vacancy authority is Registrar; publication is Super Admin.
- Candidate screening is administrative; departmental recommendation is HOD; final hiring decision is Registrar.
- Candidate acceptance, not Super Admin account creation, is the supported path into the lecturer role.
- Staff ID generation is one-time, self-service after offer acceptance, and backend enforced.
- HOD is an appointment on the lecturer account, not a second account.
- HOD and Registrar do not get routine attendance-monitoring pages or endpoints.
- Attendance recording is limited to approved assigned courses; students can view only their own attendance.
- Result recommendations do not publish official results; Registrar final approval remains required.

## Verification boundary

Modified TypeScript/TSX sources passed syntax transpilation. Dependencies were not installed and the project was not run. Runtime integration, MongoDB transaction behavior, mail delivery, actual role permissions in a deployed environment, and end-to-end workflows still require verification. Existing institutional rules and course assignments must be configured in the relevant modules.

## Lecturer module completion pass — Cloudinary and teaching materials

- Lecturer applicants must upload a CV and highest-qualification certificate; professional certificate and identity document are optional. Files are capped at 8 MB each and validated by MIME type and file signature.
- Supporting documents are uploaded server-side as **authenticated Cloudinary assets**. MongoDB stores each document's `publicId`, resource type, delivery type, format, MIME type, size and upload timestamp. API payloads returned to the UI intentionally omit private Cloudinary public IDs.
- Document downloads require an authenticated role check and return a short-lived private download URL (five minutes). Applicants/appointed lecturers can access only their own documents; HOD access is department-scoped; Super Admin and Registrar access is governed by their recruitment role.
- If application persistence fails after a successful Cloudinary upload, uploaded assets are queued/deleted through the existing Cloudinary cleanup service.
- Lecturers can upload PDF course materials (up to 15 MB) only for an approved course assigned to their account. Materials are stored as authenticated Cloudinary raw assets; MongoDB holds metadata and the private asset reference. Registered students can list/download materials only when a matching approved course-registration record exists for the course/session. Downloads are short-lived and audited.
- The lecturer workspace now exposes course assignment proposals and assessment/result submissions for HOD review. A lecturer cannot publish official results; the HOD recommendation feeds the Registrar's final approval workflow.
- The Student Attendance page also lists eligible course materials alongside attendance percentages and class-by-class attendance history.

## Verification limits

TypeScript/TSX transpilation syntax checks were performed on the modified route and UI files. The application was not run and no full dependency-backed typecheck or end-to-end Cloudinary/MongoDB integration test was performed. Configure the existing server-side `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` environment variables for uploads/downloads. Never expose the Cloudinary API secret to the frontend.

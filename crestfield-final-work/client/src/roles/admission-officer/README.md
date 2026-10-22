# Admission Officer workspace

The active interface is the Admissions route in `client/src/App.tsx`, served to users with role `ADMISSION_OFFICER`. This folder records the role contract and its boundaries; it is not a second application or an independent frontend.

## Responsibilities
- Process UTME-only applications (Direct Entry is excluded).
- Search and filter application records; assign applications to active Admission Officer accounts.
- Review documents, request clarification, record evidence-based eligibility, and mark a file ready for the next review stage.
- Create idempotent screening batches from paid, eligible, unprocessed files. If 100 or more eligible applications are available, a batch contains 100; if fewer than 100 remain, the batch contains the remainder.
- Record human decisions with reasons and policy version; issue primary offers with deadlines or alternative offers only when eligibility is explicitly confirmed and a programme capacity is configured.
- Applicants must explicitly accept or decline offers before the deadline.

## Authority and exclusions
- The workflow never invents UTME cutoffs or autonomously rejects, approves, or admits applicants.
- Account creation is not an application, fee verification, or admission decision.
- Application fee verification is performed server-side against Paystack; client-side payment claims are not trusted.
- Registrar configures the session, application open/closed state, fee, deadline, required documents, programme capacities, and screening-rules version.
- Super Admin remains technical administrator and does not make admissions decisions.

## Private documents and notifications
Required document types are configurable from Registrar workspace: passport photograph, birth certificate, citizenship certificate, signature image, JAMB/UTME result, and O'Level result(s). Files are uploaded as authenticated Cloudinary assets; the database stores private asset identifiers and metadata, not public URLs. Document access is role-checked, audited, and returned as a short-lived signed download URL.

Only the four agreed admission email events are sent through the email adapter:
1. `New Admission Application Assigned` (assigned officer)
2. `Application Requires Additional Information` (applicant)
3. `Application Ready for Review` (applicant)
4. `Admission Decision Pending` (applicant)

Other status changes use in-app notifications. Email delivery requires SMTP configuration; in-app-only user preferences suppress email.

## Main API
- `GET /api/applications/config`, `GET /api/applications/overview`, `GET /api/applications`
- `POST /api/applications/fee/initialize`, `POST /api/applications/fee/verify/:reference`
- `POST /api/applications` (multipart, no drafts), `PATCH /api/applications/:id` (only before deadline/screening)
- `GET /api/applications/:id/documents/:type`
- `POST /api/applications/:id/assign`, `PATCH /api/applications/:id/review`, `POST /api/applications/:id/clarification`
- `PATCH /api/applications/:id/eligibility`, `POST /api/applications/:id/ready-for-review`
- `POST /api/applications/screening-batches`, `GET /api/applications/screening-batches`
- `POST /api/applications/:id/decision`, `POST /api/applications/:id/alternative-offer`
- `POST /api/applications/:id/offers/:offerId/consent`

## Required server configuration
Configure `PAYSTACK_SECRET_KEY`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, and SMTP settings in the server environment. Registrar must save an admissions policy before applications can be paid/submitted and before screening batches can be created. Do not commit credentials to source control.

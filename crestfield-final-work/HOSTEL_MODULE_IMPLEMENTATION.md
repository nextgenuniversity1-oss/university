# Crestfield University — Hostel Administrator Module

## Integrated workflow implemented

1. Hostel Administrator uploads 2–3 hostel photographs and submits a listing containing name, category, location, description, academic session, room type/capacity, total bed spaces, amenities, rules, application dates, and proposed fee.
2. The listing remains staff-only while fee review is pending.
3. Bursary reviews the proposal and either returns it with a reason or forwards it to the Registrar.
4. Registrar makes the final approve/reject decision with a reason. The system does not let the Hostel Administrator publish at this stage.
5. Bursary must explicitly communicate the Registrar's decision to the Hostel Administrator.
6. After an approved decision is communicated, the Hostel Administrator may publish the listing and approved fee. The published listing is visible to students, but booking remains inactive.
7. The Hostel Administrator must separately activate booking. The student interface only enables reservation for an active listing.
8. A registered student with a matriculation number may temporarily reserve one bed for the session. The server establishes a 60-minute expiry and displays a countdown in the portal.
9. The student follows the Paystack authorization link. On return, the server verifies the reference, successful status, NGN currency, and amount against the Registrar-approved fee before confirming allocation.
10. A unique student/session lock and an atomic capacity-checked listing update prevent parallel requests from creating duplicate reservations or exceeding listed bed capacity.
11. Hostel violation records block the student's application for the recorded academic session. A revoked confirmed bed remains counted against capacity for that session.
12. Deactivating a published listing keeps its description and images visible while disabling booking; reactivation returns it to published/inactive so the Hostel Administrator must explicitly activate booking again.

## Role boundaries

- Hostel Administrator: creates listings, proposes fees, publishes only after the fee chain, and controls booking activation/deactivation.
- Bursary: reviews proposals, forwards/returns proposals, and communicates the Registrar's final decision. Payment verification remains server-side through Paystack.
- Registrar: final authority for hostel fee approval/rejection.
- Student: views published hostels and approved prices; only a registered student with a matriculation number may reserve when booking is activated.

## Technical notes and verification boundary

- API routes are mounted at `/api/hostels`.
- Hostel images use the configured Cloudinary account and are limited to JPEG, PNG, or WebP, maximum 5 MB per file, 2–3 photos per listing.
- Fee decisions, publication, activation, reservation, payment confirmation, and violation actions write audit events.
- In-app notifications and email-outbox events are queued for the fee approval chain and relevant student allocation outcomes.
- 60 TypeScript/TSX source files passed syntax transpilation checks; the ZIP archive integrity check passed.
- Dependencies were not installed and the project was not run, as requested. Therefore, runtime behavior, provider configuration, database indexes in a live MongoDB deployment, and complete end-to-end operation have not been certified.
- Room availability is capacity-based at the listing level; this implementation does not yet expose individual named bed numbers or an interactive room map.

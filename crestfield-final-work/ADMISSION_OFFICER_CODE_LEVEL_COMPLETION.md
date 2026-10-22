# Crestfield University — Admission Officer code-level completion pass

This note maps the nine requested areas to the current implementation. This is a code-level implementation record; it is not a claim that external provider credentials, production configuration, or live runtime behavior have been validated.

## 1. Application management
- UTME-only application submission; no Direct Entry flow is exposed.
- One application per applicant/session is enforced in route checks and a compound unique database index.
- Application submission requires the configured active session, an open application window, verified session fee, and all six required document categories.
- Applicants may correct editable fields/documents only before screening and before the correction deadline; there is no draft-application route.
- Admission Officer assignment is self-claim only for officers, protected by a conditional atomic update; Registrar-only reassignment is not exposed to Admission Officers.

## 2. Document handling
- Six required document categories: passport photograph, birth certificate, citizenship certificate, signature, JAMB/UTME result, and O’Level result(s).
- Upload size and declared MIME type are restricted; file signatures are checked against JPEG, PNG, and PDF formats before storage.
- Application files use authenticated Cloudinary assets; public IDs are omitted from normal application payloads, and document access uses short-lived private download URLs with access checks and audit events.
- Replaced uploads are cleaned up after a successful application update; failed cleanup is handled by the cleanup retry service.

## 3. Paystack verification
- Application fee initialization uses the Registrar-configured session and fee, with a separate explicit free-fee path only when the configured fee is zero.
- Server-side Paystack verification checks transaction reference, successful status, NGN currency, and exact expected amount before marking a fee verified.
- Payment claims are conditionally updated to prevent reuse; application submission also rejects reused references and duplicate session applications.
- Signed Paystack webhook verification checks the HMAC signature, status, currency, and amount; duplicate webhook delivery is handled idempotently.
- General payment verification now checks ownership and expected amount before persisting verified status.

## 4. Screening batches
- Batch creation requires the active session and a configured/versioned screening policy.
- Each batch selects up to 100 eligible, fee-verified, unprocessed applications; if fewer than 100 are available, the remainder are included.
- Application claims and batch creation occur in a MongoDB transaction, with a unique idempotency key and guarded updates against concurrent claims.
- Interrupted/failed batches have a recovery route that retains the original session and policy version.
- Batching does not invent cutoffs or autonomously accept/reject applicants; decisions remain human-authorized.

## 5. Admission decisions and offers
- Primary and alternative offers require explicit eligibility, verified payment, complete required documents, configured programme capacity, and a future acceptance deadline.
- Seat reservations are made inside transactions and blocked when configured capacity is missing or exhausted.
- Applicants must explicitly accept or decline offers; offer expiration is processed by a scheduled code path and also checked when applicants respond.
- Declined, expired, or revoked issued offers release reserved capacity; offer and decision history is retained.
- Terminal decisions cannot be silently overwritten through the ordinary decision endpoint.

## 6. Four required email events
- Application assigned.
- Clarification requested.
- Ready for review.
- Decision pending.
- These events create in-app notifications and stable-key email outbox records. The existing outbox processor retries transient delivery failures. Actual delivery still depends on valid SMTP settings and the user's notification preference.

## 7. Permissions and audit
- Application routes are authenticated and role-gated; applicant routes are scoped to the signed-in applicant, and staff document access is checked.
- Admission Officers cannot assign applications to another officer or invoke Registrar-only configuration/decision routes.
- Key application, payment, document access, screening, offer, and decision operations write audit events.

## 8. Frontend integration
- The admissions interface includes application submission/correction, fee initialization and verification, document upload, application search and filters, assignment, review, clarification, eligibility, ready-for-review, screening batch creation/recovery, decision entry, alternative offers, document access, and applicant offer consent.
- The policy UI displays all six required document categories as mandatory and uses configured programme capacities and policy version rather than hard-coded admission cutoffs.

## 9. Cross-workflow consistency
- Application and payment references are unique; application submission claims a verified fee and rolls back that claim if persistence fails.
- Capacity reservations and offer state changes are grouped in transactions where implemented; offer expiry runs periodically rather than depending solely on dashboard visits.
- Applicant status, decision history, in-app notification, email outbox, and audit records are updated at the relevant workflow transitions.

## Code-level boundaries
- The institution must supply approved programme capacity values and screening policy versions; the application does not invent them.
- MongoDB transaction support is required for transactional workflows.
- Cloudinary, Paystack, and SMTP operations require real environment credentials and provider configuration.
- This document records code-level implementation, not live provider verification or end-to-end runtime certification.

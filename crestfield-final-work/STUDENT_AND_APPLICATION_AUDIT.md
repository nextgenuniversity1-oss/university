# Crestfield University — Student + UTME Application Source Audit

## Changes made in this pass

- Kept the agreed UTME-only admissions process and the six mandatory document categories.
- Expanded O'Level result upload to support up to two files/sittings while preserving one mandatory O'Level document category. Backend upload limits, document persistence, correction/replacement, and staff secure-download links now handle multiple O'Level files.
- Changed the application register to count required document categories separately from the total number of uploaded files, so two O'Level results do not incorrectly make the application look as though it has more than six required categories.
- Bound the application email to the authenticated applicant account at initial submission and when an applicant tries to correct the application email. This prevents an application from being redirected to an unrelated email address while notices still go to the account holder.
- Tightened the atomic claim of a verified application-fee payment so the claim must match the active session and currently configured fee as well as the verified status and unused-reference condition.
- Added indexed retrieval for private authenticated documents so authorized staff can open either O'Level result independently; links expire after five minutes and access is audited.
- Preserved server-side Paystack reference, success-status, NGN-currency, and exact-amount verification; one application per applicant/session and one-time payment-reference claiming; private Cloudinary storage; offer acceptance/session retention; and session-specific matriculation controls.

## Student lifecycle gates preserved

- Applicant -> Admitted Student only on explicit acceptance of an unexpired offer, in the same transaction as the canonical application update.
- Admitted Student -> Registered Student only after direct, one-time matriculation generation while the global and exact-session switches are enabled and the accepted programme/department code is configured.
- Matriculation format: `YY/DEPARTMENTCODE/NNNN`; registered/graduated accounts are blocked from generating another number.
- Course registration, progression/exam review, deferment, attendance appeals, retake requests, independent clearances, and graduation transitions remain server-authorized and audited.
- Graduation approval requires institution-configured department requirements, official published results, and independently approved academic, finance, library, and departmental clearances.

## Static checks performed

- TypeScript/TSX syntax transpilation completed for 60 non-declaration TypeScript/TSX files.
- ZIP archive integrity check completed after packaging.
- No dependencies were installed and the application was not run, as requested.

## Explicit limitations — do not mistake these for runtime certification

- Syntax transpilation is not a full TypeScript type check, integration test, or end-to-end test.
- MongoDB transaction paths require a transaction-capable MongoDB deployment (replica set or sharded cluster).
- Before production, Crestfield must configure its real application fee, active admission session, Paystack/Cloudinary secrets, course catalogue, capacity rules, matriculation department codes, academic calendar, grading scale, credit limits, attendance threshold, progression rules, and graduation requirements.
- Real Paystack callbacks, email delivery, private Cloudinary retrieval, concurrent submissions, and concurrent matriculation issuance have not been runtime-tested in this pass.

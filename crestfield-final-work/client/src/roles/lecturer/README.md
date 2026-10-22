# Lecturer

This folder owns the **Lecturer** portal configuration and role-specific UI. The role is governed by server-side authorization; hiding a link is not an access-control boundary.

## Scope

Assigned courses, teaching materials, attendance, assessments, result submission and student support.

## Shared services

- API client: `../../api.ts`
- Shared components and identity: `../../shared/`
- Server permission enforcement: `../../../server/src/middleware/auth.ts`

Role-specific workflows should call authenticated API endpoints and must never perform approvals only in the browser.

## Supporting documents and course materials

Recruitment documents (CV and highest qualification certificate required; professional certificate and identity document optional) are uploaded to authenticated Cloudinary storage by the server. MongoDB keeps metadata and private Cloudinary references, never the binary file. Authorized reviewers access documents through a short-lived signed download route.

Lecturers can upload PDF course materials only for approved assigned courses. Registered students see materials only when their approved course-registration record matches the course and session. Course assignment and assessment/result submissions remain subject to HOD review; official results are not published by the lecturer.

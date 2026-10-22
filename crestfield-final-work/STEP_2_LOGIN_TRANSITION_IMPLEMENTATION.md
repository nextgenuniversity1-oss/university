# Step 2 — Login identifier transition and mandatory password change

## Implemented

1. **Lecturer login:** before Staff ID generation, email + existing password is accepted. Once `staffId` exists, email is rejected and Staff ID + existing password is required.
2. **Student login:** after a UTME application is submitted and before matriculation, JAMB/UTME number + existing password is accepted. Once a matriculation number exists, JAMB login is rejected and matriculation number + existing password is required.
3. **Generated ID triggers password change:** the existing staff-ID and matriculation-number workflows set `mustChangePassword=true`.
4. **Mandatory UI:** the client shows the dedicated forced-password-change screen when the login response/user state marks the flag true.
5. **Server enforcement:** protected endpoints now return HTTP 403 with `PASSWORD_CHANGE_REQUIRED` while the flag is true, except authenticated `/auth/me` and `/auth/change-password`. This prevents bypassing the screen by calling APIs directly.
6. **Password update:** the current password is rechecked, the new password must be at least 12 characters and different from the current password, and the flag is cleared only after saving the new hash.

## Static verification performed

- Inspected the existing login resolver, student application lookup, matriculation generator, lecturer Staff ID generator, client login form and forced-password-change component.
- Confirmed both ID-generation paths set `mustChangePassword=true`.
- Added middleware enforcement for all protected routes, with only the two required authentication endpoints exempted.
- Updated the progress tracker.

## Not claimed / not run

No dependency installation, app execution, build, database test, or end-to-end test was performed. The user previously requested not to install dependencies or run the application. Runtime verification remains pending authorization.

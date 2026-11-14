# Release status — SakanGo ASP.NET Core migration

Source baseline: existing SakanGo main branch based on commit c777eeb47d7be3864881f4bb21b724589eb1b74b.

## Implemented in C#
- .NET 8 / PostgreSQL (Npgsql), Docker container and unchanged frontend assets.
- JWT HS256 decoding/issuing; Node-compatible scrypt password calculation.
- Account registration and login, current user, owner applications and permissions.
- Property listing/search/detail, upload pictures, edits, moderation, favorites.
- Visits/leads, paid featured ads/payment confirmation, administrative reports and staff.
- CRM, projects, units, broker referrals, property management modules.
- Original Al-Bayan logo at web/assets/al-bayan-logo.jpg.

## CI verified
- dotnet restore and build (GitHub Actions)
- Docker image build and HTTP static front page
- PostgreSQL reading compatibility against original Node server seeded schema.
- Additional write tests for leads and appointments are in the workflow.

## Release gates — NOT verified, so do not cut over production yet
- Complete login and permission regression, using real legacy database schema in a staging copy.
- Ensure ALL API response formats and organizational isolation match live frontend usage.
- Validate paid featured workflow, OCR/photo upload, and read/write permissions.
- Validate the approved mobile visual reference screen by screen.
- Verify no data loss and a tested rollback.
- Validate Android/iOS/EXE artifacts separately (not created by this backend migration).

Do not edit the root Dockerfile or Render's live service until these gates pass.

# SakanGo ASP.NET Core migration — isolated branch
This is a **migration candidate**, not production-certified. The existing Render service still uses the root `Dockerfile` (Node.js). Do not change Render Dockerfile to `aspnet/Dockerfile` until all frontend API contracts, scrypt password compatibility, tenant isolation, admin privileges, and PostgreSQL migrations pass tests.

Required existing Render variables: `DATABASE_URL`, `JWT_SECRET` (40+ characters), `ADMIN_EMAIL`, `ADMIN_PASSWORD`. This .NET backend verifies existing scrypt hashes but never auto-overwrites the protected root admin. Docker image serves the unchanged current `web/` assets.

Build: `docker build -f aspnet/Dockerfile -t sakango-aspnet .`
Run: `docker run -p 10000:10000 --env-file .env sakango-aspnet`.
Health: `GET /api/health`.

Notes:
- The live frontend and API require full regression testing; do not claim parity just because compilation passes.
- The project contains no direct connection string, passwords, or personal data.
- Deploy to a separate Render preview service or branch before altering production.

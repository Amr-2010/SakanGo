#!/usr/bin/env bash
set -euo pipefail
node server/index.mjs > /tmp/sakango-old.log 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; docker rm -f sakango-ci >/dev/null 2>&1 || true' EXIT
for i in $(seq 1 40); do
  curl -fsS http://127.0.0.1:10000/api/health >/tmp/old-health.json 2>/dev/null && break
  sleep 1
done
test -s /tmp/old-health.json || { cat /tmp/sakango-old.log; exit 1; }
curl -fsS http://127.0.0.1:10000/api/listings >/tmp/old-listings.json
kill "$pid"
wait "$pid" 2>/dev/null || true
docker run -d --name sakango-ci --network host -e DATABASE_URL -e PGSSLMODE -e JWT_SECRET sakango-aspnet:ci
for i in $(seq 1 40); do
  curl -fsS http://127.0.0.1:10000/api/health >/tmp/new-health.json 2>/dev/null && break
  sleep 1
done
test -s /tmp/new-health.json || { docker logs sakango-ci; exit 1; }
curl -fsS http://127.0.0.1:10000/api/listings >/tmp/new-listings.json
python3 - <<'PY'
import json
before=json.load(open('/tmp/old-listings.json'))['items']
after=json.load(open('/tmp/new-listings.json'))['items']
assert len(before)==len(after) and len(after)>=6, (len(before),len(after))
print('Database property parity confirmed:',len(after))
PY

curl -fsS -H 'Content-Type: application/json' \
  -d '{"listing_id":"demo-1","name":"Sample Customer","phone":"01000000000","message":"Test request"}' \
  http://127.0.0.1:10000/api/leads >/tmp/dotnet-lead.json
python3 - <<'PY'
import json
lead=json.load(open('/tmp/dotnet-lead.json'))['item']
assert lead['listing_id']=='demo-1'
assert lead['status']=='new'
print('PASS: .NET PostgreSQL lead insertion')
PY

curl -fsS -H 'Content-Type: application/json' \
  -d '{"listing_id":"demo-1","name":"Sample Customer","phone":"01000000000","scheduled_at":"2099-06-01T10:00:00Z"}' \
  http://127.0.0.1:10000/api/appointments >/tmp/dotnet-appointment.json
python3 - <<'PY'
import json
visit=json.load(open('/tmp/dotnet-appointment.json'))['item']
assert visit['listing_id']=='demo-1'
assert visit['status']=='pending'
print('PASS: .NET PostgreSQL appointment insertion')
PY

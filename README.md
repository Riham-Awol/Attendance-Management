# Office Attendance

A geofenced attendance system for a single office (or several). Staff check in
and out from their phone; the app only accepts a punch made inside an office
boundary you define. It tracks lateness, absence, early departures and
overtime against each person's shift, handles leave and hourly permission
requests, and produces reports you can export to Excel.

It installs to a phone's home screen as a PWA — no app store, no download.

The app icons are generated, not committed by hand: `npm run icons` redraws
them from `tools/make-icons.js` if you want to change the colour or mark.

```
├── api/             Vercel serverless entry point
├── server/          Node + Express + MongoDB API, and the cron jobs
│   ├── domain/      Pure attendance rules (geofencing, shifts, lateness)
│   ├── modules/     One folder per feature: routes + service
│   └── tests/       Unit, service, serverless and browser tests
├── web/             The PWA (no build step — plain ES modules)
├── tools/           Icon generator
└── vercel.json      Routing and cron schedule for Vercel
```

Dependencies live in the root `package.json`, so one `npm install` covers the
API, the tests and the deployment.

## What it does

**For employees**
- One big button to check in and out. The app shows how far you are from the
  office before you press it, so there are no surprises.
- Your month at a glance: a colour-coded calendar, hours worked, lateness.
- Request leave (whole days) or permission (a few hours), and see the decision.

**For admins**
- A live dashboard: who is on site right now, who has not arrived, a 14-day
  attendance chart, and this month's worst lateness and absence.
- Approve or reject leave and permission requests. Approving a permission
  retroactively clears lateness that was already recorded for that day.
- Correct a punch when someone's phone died — every correction is stamped with
  your name in an audit trail.
- Reports by employee and by department, for any date range, exportable as
  Excel (three sheets) or CSV.
- Configure office locations and radius, shifts, working days, grace periods,
  and public holidays.
- Automatic emails: who has not checked in today, and a full monthly report.

## How attendance is decided

| Outcome | When |
|---|---|
| **Present** | Checked in within the grace period and worked the expected hours |
| **Late** | Checked in after the grace period — counted from the scheduled start |
| **Half day / Short day** | Worked less than 75% / 40% of the shift (both configurable) |
| **No check-out** | Checked in but never checked out |
| **Absent** | A working day with no check-in, no approved leave and no holiday |
| **On leave** | Covered by an approved leave request |
| **Holiday / Weekend** | A declared public holiday, or a non-working day for that shift |

Approved **permission** hours are excused: if someone has permission for
09:00–10:00 and arrives at 10:00, they are not late, and the missing hour
still counts towards their day.

Everything is calculated in the office's timezone, not the server's, and
overnight shifts (e.g. 22:00–06:00) stay on one record across midnight.

## Setup

You need **Node 18+** and **MongoDB**. If you don't have MongoDB installed, a
free [MongoDB Atlas](https://www.mongodb.com/atlas) cluster works — copy its
connection string into `MONGO_URI`.

```bash
cp server/.env.example server/.env   # then edit it — at minimum MONGO_URI and JWT_SECRET
npm install                          # installs the server's dependencies too
npm start
```

Open **http://localhost:4000** and sign in with the `ADMIN_EMAIL` and
`ADMIN_PASSWORD` from your `.env`. You will be asked to change the password
immediately.

Then, in **Settings**:

1. **Add your office.** Stand at the office and press *Use my current
   location*, or paste coordinates from Google Maps (right-click a spot →
   the numbers at the top are `latitude, longitude`). A radius of 100 m suits
   most buildings — too small and phones indoors get refused.
2. **Check the shift.** A 9–5, Monday–Friday shift with 10 minutes' grace
   exists already. Edit it or add more, and assign people to them.
3. **Add your public holidays** so nobody is marked absent on them.
4. **Add your employees** under *People*. Give each a temporary password;
   they will be asked to change it at first sign-in.

### Try it with demo data first

```bash
npm run seed
```

This creates 8 employees with 45 days of realistic history, a holiday and
some leave requests, so the dashboard and reports have something to show.
Sign in as `ada@demo.co` / `password123`, or as your admin. Re-running the
seed replaces only the demo data it created.

### Installing on a phone

The app must be served over **HTTPS** for the browser to share location
(`localhost` is exempt, which is why local testing works). Once it is on a
real domain with a certificate:

- **Android/Chrome**: open the site → menu → *Install app*.
- **iPhone/Safari**: open the site → Share → *Add to Home Screen*.

Employees should choose **Allow while using the app** when asked for location.

## Deploying

### Vercel

The repo is set up for Vercel: `api/index.js` runs the API as a serverless
function, `web/` is served straight from the CDN, and `vercel.json` wires the
two together plus the scheduled jobs.

You need a **MongoDB Atlas** database first — Vercel has no database of its
own, and it cannot reach a MongoDB on your laptop. The free M0 tier is enough.
In Atlas, under *Network Access*, allow `0.0.0.0/0`: Vercel functions do not
have fixed IP addresses, so there is nothing narrower to allow.

Then import the repo at [vercel.com/new](https://vercel.com/new) and set these
environment variables (Project → Settings → Environment Variables):

| Variable | Value |
|---|---|
| `MONGO_URI` | Your Atlas connection string, including the password |
| `JWT_SECRET` | A long random string — `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `DEFAULT_TIMEZONE` | e.g. `Africa/Addis_Ababa` |
| `ADMIN_EMAIL` | The first admin account, created on first request |
| `ADMIN_PASSWORD` | Its temporary password — you change it at first sign-in |
| `CRON_SECRET` | Another long random string; Vercel sends it to the job endpoints |

Leave the build and output settings alone — there is no build step. Deploy,
open the URL, and sign in.

**What is different on Vercel**

- **The scheduled jobs run over HTTP, not in the process.** A serverless
  function only exists while it is handling a request, so `node-cron` is
  switched off automatically (`VERCEL` is set in the environment) and Vercel
  Cron calls `/api/cron/morning` and `/api/cron/evening` instead. Those
  endpoints refuse to run unless `CRON_SECRET` is set and presented, so nobody
  can auto-close everyone's shift by visiting a URL.
- **The schedules are in UTC** and the free plan runs each job once a day.
  The defaults are `07:30` and `20:00` UTC — for a UTC+3 office that is 10:30
  and 23:00 local. Adjust the `crons` entries in `vercel.json` to suit your
  own timezone.
- **Auto-checkout runs nightly rather than hourly.** On a plan with more
  frequent crons, change the evening schedule to `0 * * * *` for the hourly
  behaviour you get when self-hosting.
- **Rate limiting is per instance.** Vercel runs many instances, so the
  sign-in limit is looser in practice than the 10-per-15-minutes it enforces
  on a single server. For a real deployment, back it with a shared store.
- **Cold starts.** The first request after a quiet spell reconnects to
  MongoDB and takes a second or two. Subsequent requests are fast.

### Anywhere that runs a normal Node process

Render, Railway, Fly.io, or your own VPS need none of the above: the server
serves the API and the PWA together and runs its own cron.

- Set every variable from `server/.env.example` in the host's settings.
- Set `NODE_ENV=production` — the server then refuses to start with a weak
  `JWT_SECRET`.
- Point `MONGO_URI` at Atlas or your own MongoDB.
- Make sure HTTPS is on. Most of these hosts do it for you.

This is the better home for the app long term: the jobs run on the schedule
they were designed for, and there are no cold starts.

If you host the PWA separately from the API, set `CORS_ORIGINS` to the
frontend's URL.

## Running the tests

```bash
npm test           # domain rules + services, no database needed
npm run test:e2e   # drives the real PWA in Chromium (needs Playwright)
```

Both can also be run from inside `server/`.

The domain tests cover the rules that decide someone's pay: geofence
distance, timezone handling across DST, grace periods, permission excusal,
overnight shifts and report totals.

The service and browser tests run against an in-memory stand-in for MongoDB
(`tests/helpers/memory-mongo.js`), because the environment this was built in
could not download a real `mongod`. It implements the parts of the driver the
app uses, including unique-index violations. **Before going live with real
payroll consequences, run the suite once against a real MongoDB** — point
`MONGO_URI` at a scratch database and swap the stand-in for `connect()`.

## Security notes

- Passwords are hashed with bcrypt; sign-in is rate limited to 10 attempts per
  15 minutes and gives the same message for a wrong password and an unknown
  account.
- Tokens are checked against the live user record on every request, so
  deactivating someone takes effect immediately.
- Admins cannot deactivate or demote themselves, and the last active admin
  cannot be removed.
- CSV exports neutralise spreadsheet formula injection.
- The app trusts the location the browser reports. That is right for an office
  of people you employ, but a determined person can spoof GPS on a rooted or
  jailbroken phone. If you need more than that, the usual next steps are a
  rotating QR code displayed at the entrance, or device binding — neither is
  built here.

## Data it stores

Per punch: time, coordinates, GPS accuracy, distance from the office, which
office, IP address and browser user-agent. Tell your staff that, and check
what your local law requires — location data about employees is regulated in
many countries.

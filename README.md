# TruckMate

[![Verify](https://github.com/Rayan-Farhan/Truck-Mate/actions/workflows/ci.yml/badge.svg)](https://github.com/Rayan-Farhan/Truck-Mate/actions/workflows/ci.yml)
[Releases](https://github.com/Rayan-Farhan/Truck-Mate/releases)

Weather-aware truck route planning and comparison. React + Django, arrival-time forecasts, distance-based exposure, a gridded corridor forecast and optional AI driver briefings.

## Run locally

Requirements: Python 3.11+, Node.js 24, npm. No database or Docker is needed for development.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.lock
cd frontend
npm ci
cd ..
```

Create a private `.env` file at the project root if one does not already exist, then fill in your TomTom key:

```dotenv
DJANGO_DEBUG=true
TOMTOM_API_KEY=your-tomtom-api-key
```

`.env` is excluded from Git. Preserve existing credentials when updating it. Development mode generates a temporary Django secret if one is not configured; production requires a private `DJANGO_SECRET_KEY` and `DJANGO_DEBUG=false`.

Start the backend and frontend in separate terminals from the project root:

```powershell
.\.venv\Scripts\python.exe backend\manage.py runserver 127.0.0.1:8000 --noreload
```

```powershell
cd frontend
npm run dev
```

Open **http://127.0.0.1:5173/**. Stop each server with Ctrl+C, and restart the backend after changing `.env`. The frontend build helper invokes Node directly so Windows paths containing spaces or `&` work.

## Live routing and weather

The app opens directly to the live planner. It makes no automatic analysis request on page load. Demo tabs and scenario controls are removed; synthetic requests are rejected by the public API. Internal policy fixtures remain available only to the automated test process.

To plan a trip:

1. Set `TOMTOM_API_KEY` in `.env`; restart the backend.
2. Choose both locations from the search results.
3. Choose a current/future departure, timezone, payload and 10/25/50-mile interval.

**Open-Meteo's public API is keyless.** It needs no account or API key. The public endpoint's non-commercial terms and quotas apply. A custom commercial endpoint can be configured separately when needed; the public endpoint is sufficient for non-commercial development.

Live mode never falls back to demonstration weather or geometry. Missing credentials produce an explicit error. Failed/missing forecasts stay Unknown. The current acceptance geography is the contiguous United States (input bounds are validated).

Live route discovery requests the primary truck route plus up to five alternatives, then keeps three distinct candidates. Trips whose endpoints are more than 750 km apart initially request two alternatives with a 30-second read budget; shorter trips use the usual 12-second budget. This avoids asking the provider to calculate six long-distance paths before showing any result. If fewer than three remain, the search tries circular through-areas on either side of the primary road corridor, with the same departure and truck profile. It admits at most five logical route queries within 32 seconds; each optional query has a timeout of at most five seconds. Brief connection failures or server errors may be retried once within each query's remaining budget. Read timeouts, credentials errors and rate limits are reported explicitly. These are admission/read budgets, not a strict total wall-clock deadline.

Duplicate paths, substantial exact road retracing, and routes exceeding 1.75 times the baseline distance or twice its duration are excluded. These are search bounds, not proof that other routes do not exist. A partial search preserves usable results and reports its limits; it never duplicates a route to fill three cards.

## Optional AI briefing

The route decision is calculated before any model call. Briefings load independently:

**Amazon Bedrock → Groq → calculated explanation**.

- For Bedrock, configure an AWS credential profile locally or an IAM instance role on EC2. Set `BEDROCK_ENABLED=true`, the region, and `BEDROCK_MODEL_ID` (default `amazon.nova-micro-v1:0`). Verify model access, inference quota and credit eligibility.
- For Groq, set `GROQ_API_KEY` and `GROQ_MODEL` to a model available on your account. Availability and free-plan limits can vary.
- With neither provider configured, the calculated explanation remains fully functional.

Models receive compact server-owned facts, not an instruction to solve routing. Unknown fact references, changed recommendation IDs, unsupported numerical output and some absolute claims are rejected. Numeric placeholders are filled from verified facts. This is **not a proof that arbitrary generated prose is correct**; the canonical comparison and warnings remain visible.

AI calls have bounded timeouts, a daily application request allowance, small token budgets and caching. The daily limit is shared by threads in the single configured application worker; it is not a distributed billing hard cap.

## Calculation policies

| Hazard           | Low   | Moderate     | High         | Severe      | No Travel |
| ---------------- | ----- | ------------ | ------------ | ----------- | --------- |
| Wind mph         | <25   | 25–<35     | 35–<45     | 45–<55    | ≥55     |
| Rain in/hr       | <0.10 | 0.10–<0.25 | 0.25–<0.50 | 0.50–1.00 | >1.00     |
| Fresh snow in/hr | <0.5  | 0.5–<1     | 1–<2       | 2–3       | >3        |

Shared precipitation boundaries enter the higher class, except the strictly greater No Travel thresholds. Values are not rounded before classification. Sustained wind drives the policy; gusts are displayed separately.

Load rules: ≥55 mph blocks any load; 45–<55 mph plus payload >30,000 lb is No Travel; 35–<45 mph plus payload >40,000 lb is Severe. Exactly 30,000/40,000 lb does not escalate. Simultaneous hazards take the maximum, retaining all tied reasons.

Live truck routing assumes a **35,000 lb tare**, plus the entered payload, and dimensions **4.11 m high × 2.6 m wide × 21.64 m long**. These are default vehicle assumptions; they do not verify a particular truck. The UI accepts 0–80,000 lb of cargo as an application input range, not a statement of legal payload limits. ETAs exclude breaks/rest stops.

### Geometry and ETA

Checkpoints use cumulative provider distance at exact mile targets, including origin and destination. WGS84 geodesics interpolate positions. Provider travel-time progress is used where available; proportional timing is identified as an approximation. Route alternatives are checked using sampled path overlap, not only similar distance/duration. Alternatives are never padded to three.

Midpoints between checkpoints define exposure cells. Their lengths partition the trip with no gaps/overlap, and the **same backend-generated cells** supply map segment geometry and summary metrics. Distances are aggregated in millimeters before display conversion.

### Forecast matching

The weather adapter explicitly requests metric units and verifies returned metadata. It converts m/s to mph, adds rain + showers before converting mm to inches, and converts fresh snowfall cm to inches. Snow depth and water-equivalent precipitation are not substituted for fresh snow.

Instantaneous sustained wind is interpolated between valid hourly brackets. Rain/snow use the preceding-hour accumulation interval containing the ETA, with convention `(start, end]`; rates are hourly means. Gusts use the applicable interval maximum. Missing hours, values and out-of-horizon times remain Unknown; no endpoint clamping or extrapolation occurs.

Departure local time is resolved using the chosen IANA zone. Nonexistent daylight-saving times are rejected; repeated times require an offset choice. Calculations use UTC.

### Recommendation

Exclude blocked/incomplete routes. Among eligible routes, compare **Severe distance → High distance → distance-weighted ordinal average → duration** lexicographically, with stable route identity as the final tie-break. Ordinal codes are 0–4; they are not probabilities. If every route is blocked/incomplete, recommendation ID is null.

The explanation compares the selected option with the fastest eligible competitor and reports the actual deciding criterion. A small deciding exposure is not rounded to zero during selection.

### Corridor forecast

The selected route is buffered by 20 miles per side in a local metric projection. Clipped grid cells start at approximately 15-mile spacing, adapt to a 192-cell budget, and carry 49 forecast positions from **exact departure +0 to +48 hours**. The effective spacing is displayed. The overlay is a sampled area field, not a density heatmap or a promise of fine spatial resolution. Wind/rain/snow and load-adjusted risk modes share the same cells.

All frames load together. Scrubbing changes map data locally, without new API requests or changing the journey recommendation. Unknown cells are gray. The map's route colors always refer to checkpoint arrival times, independently of the forecast slider.

## Architecture and API

`backend/routing/domain.py` is framework/network independent. Geometry, provider adapters, orchestration, presentation and briefings are separate. No persistent database or job queue is required. Django's bounded local-memory cache is disposable and process-local; the container uses one worker with four threads deliberately. Multiple workers/replicas require revisiting quota coordination and analysis-cache sharing.

| Method | Path                          | Meaning                                  |
| ------ | ----------------------------- | ---------------------------------------- |
| GET    | `/api/health`                 | Liveness, no upstream calls              |
| GET    | `/api/config`                 | Capability flags, no credentials         |
| GET    | `/api/places?q=...`           | US geocoding candidates                  |
| POST   | `/api/analyses`               | Route/ETA/weather/risk/recommendation    |
| POST   | `/api/analyses/{id}/corridor` | Forecast for `route_id`                  |
| POST   | `/api/analyses/{id}/briefing` | Optional narration of server-owned facts |

Request validation and endpoint behavior are defined in `backend/routing/api.py`, with examples in `backend/routing/tests/test_api.py`. Analyses expire after 30 minutes or on server/cache restart. Expiration returns 410; already displayed analysis data remains usable. Provider errors never echo credential-bearing URLs.

## Verification

```powershell
.\.venv\Scripts\python.exe backend\manage.py test routing.tests
cd frontend
npm run test
npm run build
```

The backend and frontend unit tests above do not depend on live services. They cover thresholds, load rules, unknown data, eligibility, distance conservation, nonuniform ETA, forecast interval matching, timezone transitions, provider parsing, API orchestration and AI fallback.

Browser regressions in `frontend/e2e/planner.spec.ts` run against the development servers started above. From `frontend`, install Playwright's Chromium browser once, then run the desktop/mobile suite:

```powershell
node node_modules/@playwright/test/cli.js install chromium
npm run test:e2e
```

The suite uses `http://127.0.0.1:5173` by default; set `PREVIEW_URL` to target another running app. No separate QA server is required.

Live acceptance cases are in `frontend/e2e/live.spec.ts`. After `npm run build`, start the configured backend and run `npm run test:live` from `frontend`. The suite uses `http://127.0.0.1:8000` by default, or `LIVE_URL` when set. It uses installed Chrome by default; set `PLAYWRIGHT_CHANNEL=chromium` to use the browser installed above. It calls real routing and weather providers, saves raw evidence under the ignored `.cache/` directory, and independently checks checkpoint risk, route ranking and corridor frames. Review forecast-selected dates before rerunning.

Build output, test reports and caches are generated locally and excluded from Git. Removing them does not change application source; builds and test runs recreate the outputs they need. Public AWS deployment is verified. Real Bedrock inference remains blocked by the account's zero applied Nova Micro token quota in Sydney; the hosted briefing check returned the calculated fallback.

## AWS deployment

`deploy/aws.yaml` defines the CloudFormation stack, and `deploy/deploy.py` prepares or launches it. The template provisions one EC2 instance, IAM instance role, encrypted EBS, public IPv4, a CloudFront distribution and origin access restrictions. Configuration is held in Secrets Manager. CloudFront provides a generated `https://<distribution>.cloudfront.net` address; **no domain purchase is needed**.

`deploy/publish.py --push` builds, checks and uploads the image to **private Amazon ECR**. The server pulls it using its IAM role. Version tags trigger GitHub verification and private-image publishing, deployment when `DEPLOY_ENABLED=true`, and a GitHub Release with the source commit and immutable image digest. GitHub authenticates to AWS through scoped OIDC roles, with no stored AWS access keys. Follow [the deployment guide](deploy/README.md) and [CI/CD guide](deploy/CICD.md) for setup, publishing and rollback. GitHub Packages stays empty because the container registry is private AWS ECR.

The deployment uses one application instance. AWS, TomTom and Groq usage is subject to each provider's pricing, quotas and account limits.

Hosted address: **[TruckMate](https://d1fmez7o5mdp8o.cloudfront.net)**. **EC2 is temporarily stopped and production deployment is disabled.** The retained Sydney (`ap-southeast-2`) deployment passed public HTTPS health, frontend assets, redirect, three evaluated Chicago–Milwaukee routes and 49 corridor forecast positions on November 9, 2026. Its container runs as a non-root user without embedded AWS access keys. AI capability flags indicate configuration rather than successful inference; the Bedrock quota request is pending.

## Sources and attribution

- [TomTom routing](https://docs.tomtom.com/routing-api/documentation/tomtom-maps/v1/calculate-route), [geocoding](https://docs.tomtom.com/geocoding-api/documentation/tomtom-maps/v1/geocode).
- [Open-Meteo](https://open-meteo.com/), [field definitions](https://open-meteo.com/en/docs), [usage terms](https://open-meteo.com/en/terms). Forecast data is CC BY 4.0; values are converted, matched and sampled by this application.
- [OpenFreeMap](https://openfreemap.org/) and © OpenStreetMap contributors provide the map data; [MapLibre](https://maplibre.org/) renders it.
- Internal test-fixture geometry was recorded from the [OSRM](https://project-osrm.org/) public driving router on 2026-11-08, using © OpenStreetMap contributors' data. Internal weather fixtures are synthetic and are not used by the public application.
- [Amazon Bedrock Nova Micro](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-micro.html), [Groq models](https://console.groq.com/docs/models).

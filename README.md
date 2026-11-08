# TruckMate

Weather-aware truck route planning and comparison. React + Django, arrival-time forecasts, distance-based exposure, a gridded corridor forecast and optional AI driver briefings.

> **Repository status:** This initial publication contains only the README. Application source, configuration, tests and deployment files are currently maintained locally and have not yet been published. The setup instructions below apply once the source is available.

## Run locally

Requirements: Python 3.11+, Node.js 24, npm. No database or Docker is needed for development.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.lock
cd frontend
npm ci
cd ..
```

Copy `.env.example` to a private `.env` file if one does not already exist, then fill in the credentials you need. `.env` is excluded from Git. Never overwrite an existing credentials file.

```powershell
pwsh -File scripts/dev.ps1
```

Open **http://127.0.0.1:5173/**. The script runs both servers; Ctrl+C stops them. Alternatively, run these in separate terminals:

```powershell
.\.venv\Scripts\python.exe backend\manage.py runserver 127.0.0.1:8000 --noreload
```

```powershell
cd frontend
npm run dev
```

Restart the backend after changing `.env`. Stop any earlier servers before running the combined script. Build scripts invoke Node directly so Windows paths containing spaces or `&` work.

## Demo and live data

The app starts with a **clearly labeled demonstration**: three recorded road paths from Chicago to Denver, with synthetic time-varying weather. These are OSRM **driving** fixtures, not proof of truck-legal routes. Via Sioux Falls and via Kansas City provide geographically distinct alternatives. No routing or weather credentials are needed for demos.

Scenarios: storm trade-off, clear weather, all routes blocked, missing western forecasts, and a 45 mph wind / payload-boundary case. Change the scenario or payload and click **Update route analysis**.

For live analysis:

1. Set `TOMTOM_API_KEY` in `.env`; restart the backend.
2. Select **Live APIs** and choose both locations from the search results.
3. Choose a current/future departure, timezone, payload and 10/25/50-mile interval.

**Open-Meteo's public API is keyless.** It needs no account or API key. The public endpoint's non-commercial terms and quotas apply. A custom commercial endpoint can be configured separately when needed; the public endpoint is sufficient for non-commercial development.

Live mode never falls back to demonstration weather or geometry. Missing credentials produce an explicit error. Failed/missing forecasts stay Unknown. The current acceptance geography is the contiguous United States (input bounds are validated).

## Optional AI briefing

The route decision is calculated before any model call. Briefings load independently:

**Amazon Bedrock â†’ Groq â†’ calculated explanation**.

- For Bedrock, configure an AWS credential profile locally or an IAM instance role on EC2. Set `BEDROCK_ENABLED=true`, the region, and `BEDROCK_MODEL_ID` (default `amazon.nova-micro-v1:0`). Verify model access, inference quota and credit eligibility.
- For Groq, set `GROQ_API_KEY` and `GROQ_MODEL` to a model available on your account. Availability and free-plan limits can vary.
- With neither provider configured, the calculated explanation remains fully functional.

Models receive compact server-owned facts, not an instruction to solve routing. Unknown fact references, changed recommendation IDs, unsupported numerical output and some absolute claims are rejected. Numeric placeholders are filled from verified facts. This is **not a proof that arbitrary generated prose is correct**; the canonical comparison and warnings remain visible.

AI calls have bounded timeouts, a daily application request allowance, small token budgets and caching. The daily limit is shared by threads in the single configured application worker; it is not a distributed billing hard cap.

## Calculation policies

| Hazard           | Low   | Moderate     | High         | Severe      | No Travel |
| ---------------- | ----- | ------------ | ------------ | ----------- | --------- |
| Wind mph         | <25   | 25â€“<35     | 35â€“<45     | 45â€“<55    | â‰¥55     |
| Rain in/hr       | <0.10 | 0.10â€“<0.25 | 0.25â€“<0.50 | 0.50â€“1.00 | >1.00     |
| Fresh snow in/hr | <0.5  | 0.5â€“<1     | 1â€“<2       | 2â€“3       | >3        |

Shared precipitation boundaries enter the higher class, except the strictly greater No Travel thresholds. Values are not rounded before classification. Sustained wind drives the policy; gusts are displayed separately.

Load rules: â‰¥55 mph blocks any load; 45â€“<55 mph plus payload >30,000 lb is No Travel; 35â€“<45 mph plus payload >40,000 lb is Severe. Exactly 30,000/40,000 lb does not escalate. Simultaneous hazards take the maximum, retaining all tied reasons.

Live truck routing assumes a **35,000 lb tare**, plus the entered payload, and dimensions **4.11 m high Ã— 2.6 m wide Ã— 21.64 m long**. These are default vehicle assumptions; they do not verify a particular truck. The UI accepts 0â€“80,000 lb of cargo as an application input range, not a statement of legal payload limits. ETAs exclude breaks/rest stops.

### Geometry and ETA

Checkpoints use cumulative provider distance at exact mile targets, including origin and destination. WGS84 geodesics interpolate positions. Provider travel-time progress is used where available; proportional timing is identified as an approximation. Route alternatives are checked using sampled path overlap, not only similar distance/duration. Alternatives are never padded to three.

Midpoints between checkpoints define exposure cells. Their lengths partition the trip with no gaps/overlap, and the **same backend-generated cells** supply map segment geometry and summary metrics. Distances are aggregated in millimeters before display conversion.

### Forecast matching

The weather adapter explicitly requests metric units and verifies returned metadata. It converts m/s to mph, adds rain + showers before converting mm to inches, and converts fresh snowfall cm to inches. Snow depth and water-equivalent precipitation are not substituted for fresh snow.

Instantaneous sustained wind is interpolated between valid hourly brackets. Rain/snow use the preceding-hour accumulation interval containing the ETA, with convention `(start, end]`; rates are hourly means. Gusts use the applicable interval maximum. Missing hours, values and out-of-horizon times remain Unknown; no endpoint clamping or extrapolation occurs.

Departure local time is resolved using the chosen IANA zone. Nonexistent daylight-saving times are rejected; repeated times require an offset choice. Calculations use UTC.

### Recommendation

Exclude blocked/incomplete routes. Among eligible routes, compare **Severe distance â†’ High distance â†’ distance-weighted ordinal average â†’ duration** lexicographically, with stable route identity as the final tie-break. Ordinal codes are 0â€“4; they are not probabilities. If every route is blocked/incomplete, recommendation ID is null.

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

Additional API examples are maintained in `docs/api.md` with the unpublished source. Analyses expire after 30 minutes or on server/cache restart. Expiration returns 410; already displayed analysis data remains usable. Provider errors never echo credential-bearing URLs.

## Verification

```powershell
.\.venv\Scripts\python.exe backend\manage.py test routing.tests
cd frontend
npm run test
npm run build
```

Tests do not depend on live services. They cover thresholds, load rules, unknown data, eligibility, distance conservation, nonuniform ETA, forecast interval matching, timezone transitions, provider parsing, API orchestration and AI fallback.

Desktop/mobile browser scenarios are included in the local source under `frontend/e2e`. Browser testing and visual map verification remain pending.

Local verification includes 53 backend tests, 18 frontend tests, a production frontend build and a Linux Docker build. Live TomTom route analysis, keyless Open-Meteo forecasts and a Groq briefing have also been exercised. Real Bedrock inference and AWS deployment remain pending.

## AWS deployment

Deployment instructions are maintained in `deploy/README.md` with the unpublished source. The CloudFormation template provisions one EC2 instance, IAM instance role, encrypted EBS, public IPv4, a CloudFront distribution and origin access restrictions. Configuration is held in Secrets Manager. CloudFront provides a generated `https://â€¦cloudfront.net` address; **no domain purchase is needed**.

The deployment uses one application instance. AWS, TomTom and Groq usage is subject to each provider's pricing, quotas and account limits.

Cloud provisioning and public HTTPS verification are pending.

## Sources and attribution

- [TomTom routing](https://docs.tomtom.com/routing-api/documentation/tomtom-maps/v1/calculate-route), [geocoding](https://docs.tomtom.com/geocoding-api/documentation/tomtom-maps/v1/geocode).
- [Open-Meteo](https://open-meteo.com/), [field definitions](https://open-meteo.com/en/docs), [usage terms](https://open-meteo.com/en/terms). Forecast data is CC BY 4.0; values are converted, matched and sampled by this application.
- [OpenFreeMap](https://openfreemap.org/) and Â© OpenStreetMap contributors provide the map data; [MapLibre](https://maplibre.org/) renders it.
- Demo geometry was recorded from the [OSRM](https://project-osrm.org/) public driving router on 2026-11-08, using Â© OpenStreetMap contributors' data. Demo weather is synthetic.
- [Amazon Bedrock Nova Micro](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-micro.html), [Groq models](https://console.groq.com/docs/models).

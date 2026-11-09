# TruckMate

TruckMate helps truck drivers compare routes using weather forecasts, payload weight and travel time. It matches conditions to estimated arrival times along each route, shows where hazardous exposure occurs and explains why one route is recommended.

**[Open TruckMate](https://d1fmez7o5mdp8o.cloudfront.net)** · Hosted on AWS · React + Django

## Features

- **Truck route comparison:** search real locations and compare up to three distinct truck routes, with distance, travel time, arrival time and weather exposure for each option.
- **Weather at arrival:** sample the journey every **10, 25 or 50 miles**, including both endpoints, and match wind, rain and snowfall to the truck's estimated arrival at each checkpoint.
- **Payload-aware risk:** classify conditions from **Low** to **No Travel**, applying additional wind restrictions for heavier loads.
- **Explainable recommendations:** prioritize Severe exposure, High exposure, average risk and travel time, with a written explanation of the deciding factor.
- **Interactive route map:** inspect routes, colored risk segments and checkpoints. Route cards, the checkpoint inspector and the weather table stay synchronized as you explore.
- **48-hour corridor forecast:** switch between Wind, Rain, Snow and Risk overlays, then scrub from departure through **+48 hours**. Forecast frames load together so the slider updates without additional API requests.
- **Desktop and mobile layouts:** compare routes, navigate checkpoints, show or hide weather layers and use location search with a keyboard or pointer.
- **Optional driver briefings:** summarize the calculated trip facts through Amazon Bedrock or Groq, with a calculated explanation available when AI services cannot respond.

## Using the hosted app

1. Select an origin and destination from the location suggestions.
2. Choose a departure date, time and timezone, enter the cargo weight and select checkpoint spacing.
3. Plan the trip and compare the returned routes, exposure summaries and recommendation.
4. Select a route to inspect checkpoint ETAs and weather, or explore its corridor with the forecast slider.

The hosted app needs no installation or API keys from the visitor. Coverage is currently the **contiguous United States**. If route discovery finds fewer than three distinct options, the app shows the available routes with a warning. Missing forecasts remain **Unknown**, rather than being treated as calm weather.

## Technology stack

| Layer                     | Technologies                                     | Role                                                     |
| ------------------------- | ------------------------------------------------ | -------------------------------------------------------- |
| Frontend                  | React 19, TypeScript, Vite, Tailwind CSS         | Planner, route comparison and responsive interface       |
| Maps and data             | MapLibre GL, OpenFreeMap, TanStack Query         | Interactive map, weather overlays and API state          |
| Backend                   | Python 3.11, Django 5.2, Django REST Framework   | Validation, trip orchestration and JSON API              |
| Routing and weather       | TomTom, Open-Meteo                               | Geocoding, truck routes, travel times and forecasts      |
| Geospatial calculations   | PyProj, Shapely, NumPy                           | Route sampling, distance calculations and corridor grids |
| Application runtime       | Docker, Gunicorn, WhiteNoise                     | Containerized backend and built frontend                 |
| Verification and delivery | Django tests, Vitest, Playwright, GitHub Actions | Calculation tests, browser checks and versioned delivery |

The backend separates provider integrations, geometry, risk calculations and presentation. It calculates the recommendation before requesting any AI briefing. Trip analyses use a bounded in-memory cache; no persistent database or job queue is required.

## AWS hosting and delivery

TruckMate runs in **Sydney (`ap-southeast-2`)**. The HTTPS site serves the frontend and API through CloudFront, backed by one EC2 instance running the application container.

| Service                | Purpose                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------- |
| Amazon CloudFront      | Public HTTPS access to the application                                             |
| Amazon EC2             | Runs the Docker container                                                          |
| Amazon CloudWatch Logs | Collects application, service and CloudFront access logs with seven-day retention  |
| Amazon ECR             | Stores private application images with immutable version tags                      |
| AWS Secrets Manager    | Holds server configuration and application secrets                                 |
| AWS IAM                | Gives the instance and delivery workflow scoped access to AWS services             |
| AWS Systems Manager    | Updates the running image and restores the previous image after a failed startup   |
| Amazon Bedrock         | Optional Amazon Nova 2 Lite driver briefings, subject to available inference quota |

Application secrets stay on the server. GitHub Actions authenticates to AWS using short-lived **OIDC credentials**. Delivery uses immutable image digests, serializes deployments and checks application health, with rollback after a failed public health check. The current setup uses a single instance, so updates can cause brief restart downtime.

In CloudWatch **Logs → Log groups**, select Sydney for `/truckmate/application` (Docker output) and `/truckmate/service` (systemd startup and deployment logs). CloudFront standard access logs use `truckmate-cloudfront` in **N. Virginia (`us-east-1`)**. A CloudWatch agent collects the instance logs, and CloudFront uses standard logging v2. All three groups retain logs for seven days.

Two workflows handle verification and delivery:

- **[CI](.github/workflows/ci.yml):** checks the backend, frontend, desktop/mobile browser behavior and Docker container on pull requests and `main`. Tests run without production credentials or live provider calls.
- **[CD](.github/workflows/cd.yml):** verifies a versioned commit, builds and checks its image, publishes it to private ECR, deploys when enabled and creates a GitHub Release containing source and image metadata. Published versions can be redeployed or used for rollback.

Infrastructure and server startup configuration are managed in AWS. These workflows deliver application updates to that existing setup.

<details>
<summary>Release and rollback operations</summary>

Repository variables are configured under **Settings → Secrets and variables → Actions**: `AWS_REGION`, `ECR_REPOSITORY`, `APP_STACK`, `AWS_PUBLISH_ROLE_ARN`, `AWS_DEPLOY_ROLE_ARN` and `DEPLOY_ENABLED`. Setting `DEPLOY_ENABLED=false` pauses deployment while still allowing image publication.

From `frontend`, run `npm version VERSION --no-git-tag-version` to update the package version and lockfile. Commit and merge the change to `main`, then push a matching annotated tag, for example:

```powershell
git tag -a v1.0.0 -m "TruckMate v1.0.0"
git push origin v1.0.0
```

The tag must match `frontend/package.json` and point to a commit on `main`. GitHub Releases record the commit and immutable image digest in `image.json`; container images remain in private ECR.

To redeploy or roll back, select **Actions → CD → Run workflow** on `main` and enter an existing published version. The workflow retrieves the original image. EC2 must already be running; CD does not start a stopped instance.

</details>

## How route recommendations work

### Checkpoint weather and risk

Checkpoints follow cumulative route distance and use provider travel-time progress to estimate arrival, with proportional timing identified when needed. Sustained wind is interpolated between valid hourly forecasts; rain and fresh snowfall use the applicable preceding-hour accumulation interval. Values are converted to mph and inches per hour before classification.

| Condition          | Low   | Moderate   | High       | Severe    | No Travel |
| ------------------ | ----- | ---------- | ---------- | --------- | --------- |
| Wind (mph)         | <25   | 25–<35     | 35–<45     | 45–<55    | ≥55       |
| Rain (in/hr)       | <0.10 | 0.10–<0.25 | 0.25–<0.50 | 0.50–1.00 | >1.00     |
| Fresh snow (in/hr) | <0.5  | 0.5–<1     | 1–<2       | 2–3       | >3        |

The highest applicable hazard determines checkpoint risk. Shared precipitation boundaries enter the higher band, except the strictly greater No Travel thresholds. Gusts are displayed separately from sustained wind.

Payload rules apply additional wind restrictions:

- **≥55 mph:** No Travel for every load.
- **45–<55 mph and payload >30,000 lb:** No Travel.
- **35–<45 mph and payload >40,000 lb:** Severe.

Truck routing assumes a **35,000 lb tare** plus cargo and dimensions of **4.11 m × 2.6 m × 21.64 m**. The comparison supports planning; it cannot establish that a trip is safe.

### Route ranking

Each checkpoint represents the distance between the midpoints to its neighbors. This partitions the route into exposure segments and keeps map colors and route totals consistent.

Routes with No Travel conditions or incomplete forecasts are excluded from recommendations. Eligible routes are ranked in this order:

1. Fewest Severe miles.
2. Fewest High miles.
3. Lowest distance-weighted average risk.
4. Shortest travel time.

A stable route identity resolves exact ties. If no route is eligible, TruckMate shows no recommendation. The explanation identifies the deciding criterion against the fastest eligible competitor.

### Corridor forecast and driver briefings

The selected route has a **20-mile buffer on each side**, sampled on an adaptive grid with 49 forecast frames from departure through +48 hours. The slider explores this surrounding weather field; route colors and recommendations continue to represent conditions at checkpoint arrival times. Unknown grid values are shown in gray.

Select **Generate briefing** after planning a trip to request an optional driver briefing. Briefings follow **Amazon Bedrock → Groq → calculated explanation**, and the interface identifies the source. They load separately from the map and route comparison. Models receive compact trip facts and their responses are checked for supported references and numerical claims. They do not determine route rankings. Timeouts, caching and application request limits bound AI calls; generated prose can still contain errors.

## Known limitations

- **Coverage and route availability:** planning covers the contiguous United States. The bounded search can return fewer than three distinct routes and does not consider every possible alternative.
- **Forecast and vehicle assumptions:** forecasts can change or contain gaps, and the corridor grid samples conditions rather than resolving every road location. Missing forecasts remain Unknown. Routing uses default truck dimensions and tare weight; ETAs exclude driver breaks.
- **AI availability and accuracy:** Bedrock and Groq depend on provider quotas and availability. Briefings fall back to a calculated explanation; response validation cannot guarantee error-free generated prose.
- **Single-instance hosting and temporary storage:** updates can briefly interrupt service, with no automatic application failover. Analyses expire after 30 minutes or a restart, and trip history is not persisted. Scaling to multiple workers or replicas requires shared cache and quota coordination.

## Data sources

- **[TomTom](https://docs.tomtom.com/routing-api/documentation/tomtom-maps/v1/calculate-route):** truck routing and [geocoding](https://docs.tomtom.com/geocoding-api/documentation/tomtom-maps/v1/geocode).
- **[Open-Meteo](https://open-meteo.com/en/docs):** wind, rain and snowfall forecasts. Forecast data is CC BY 4.0; the public API's [non-commercial terms and quotas](https://open-meteo.com/en/terms) apply.
- **[OpenFreeMap](https://openfreemap.org/), © OpenStreetMap contributors and [MapLibre](https://maplibre.org/):** basemap data and rendering.
- **[Amazon Nova](https://docs.aws.amazon.com/nova/latest/userguide/what-is-nova.html) and [Groq](https://console.groq.com/docs/models):** optional language-model integrations.
- Internal route fixtures use geometry recorded from [OSRM](https://project-osrm.org/) on November 8, 2026, using © OpenStreetMap contributors' data. Synthetic weather fixtures are confined to automated tests.

## Run locally

Local development requires **Python 3.11+, Node.js 24 and npm**. Docker and a database are not required.

### Install and configure

From the project root, using PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend\requirements.lock
cd frontend
npm ci
cd ..
```

Create a private `.env` in the project root:

```dotenv
DJANGO_DEBUG=true
TOMTOM_API_KEY=your-tomtom-api-key
```

The TomTom key enables live location search and routing. Open-Meteo's public forecast endpoint needs no key. `.env` is excluded from Git; preserve any existing credentials when editing it. Development mode generates a temporary Django secret automatically.

AI briefings are optional. To use Bedrock locally, configure an AWS credential profile and set `BEDROCK_ENABLED=true`, `AWS_REGION` and `BEDROCK_MODEL_ID` in `.env`. Nova 2 Lite uses an inference profile, such as `global.amazon.nova-2-lite-v1:0`, rather than its base model ID. For Groq, set `GROQ_API_KEY` and `GROQ_MODEL`. Without either service, the calculated explanation remains available.

### Start the app

Run the backend from the project root:

```powershell
.\.venv\Scripts\python.exe backend\manage.py runserver 127.0.0.1:8000 --noreload
```

In a second terminal:

```powershell
cd frontend
npm run dev
```

Open **http://127.0.0.1:5173/**. Restart the backend after changing `.env`.

For a local container build, set a persistent random `DJANGO_SECRET_KEY` in `.env`, then run `docker compose up --build` and open **http://127.0.0.1:8000/**. Compose uses `DJANGO_DEBUG=false`. The hosted deployment loads these production settings from AWS Secrets Manager.

### Run checks

From the project root:

```powershell
.\.venv\Scripts\python.exe backend\manage.py test routing.tests
cd frontend
npm run test
npm run build
node node_modules/@playwright/test/cli.js install chromium
npm run test:e2e
```

Unit tests cover risk boundaries, payload rules, route ranking, distance conservation, arrival times, forecast matching, timezone transitions and provider failures. Browser tests cover desktop and mobile behavior with controlled API responses and start the frontend automatically.

The separate live browser suite calls real providers. After building the frontend, run the backend at `http://127.0.0.1:8000` and run `npm run test:live` from `frontend`. It uses installed Chrome by default; set `PLAYWRIGHT_CHANNEL=chromium` to use Playwright's browser or `LIVE_URL` to target another running app. Check trip dates before running; evidence is saved under ignored `test-results/`.

# TruckMate fleet platform implementation plan

Build two signed-in workspaces in the existing React and Django app. Fleet admins assign and monitor deliveries. Drivers open assigned jobs in the weather-aware planner, search routes independently, and report progress.

## 1. Add fleet data and accounts in Django

- Add a `backend/fleet/` app with company, membership, job, and job update models. Use Django users and give each membership an admin or driver role.
- Configure PostgreSQL and add migrations. Store pickup and delivery locations, planned departure, cargo weight, delivery deadline, and driver assignment. Keep timestamped records of status changes, ETAs, and delay reasons.
- Enable Django sessions and CSRF protection. Add login, logout, current user, and invite and password reset flows. Add a management command to create the first company and admin. Let admins invite and deactivate their own drivers.
- Scope fleet API reads and writes to the signed-in user’s company and role. Drivers can update jobs assigned to them. Admins can create, edit, assign, reassign, and cancel jobs within their company.

## 2. Connect the driver workspace to the planner

- Add a mobile-friendly list of assigned jobs. Open a job in the existing planner with pickup, destination, departure, and cargo weight filled in. Give drivers a separate entry to plan a route independently.
- Keep the existing map, route comparison, forecasts, and briefing. When a driver confirms a route for a job, save its summary and planned ETA to PostgreSQL so the job stays usable after the analysis cache expires.
- Let drivers mark a job en route or delivered and report a delay with a revised ETA and reason. Save the job change and its history together.

## 3. Build the fleet admin workspace

- Show a driver roster and a job board with assignment, progress, deadline, latest ETA, and last check-in. Let admins manage drivers and job assignments from this workspace.
- Flag a job as at risk when its current ETA exceeds the deadline and overdue when the deadline has passed without delivery. Show missing or stale ETAs explicitly. Refresh the board periodically so driver updates appear without a page reload.

## 4. Connect AWS RDS and update deployment

- Check the existing AWS stack and reuse an appropriate RDS PostgreSQL instance if available. Otherwise, provision one privately in the app’s AWS network and allow database connections from the app’s security group. Configure backups and store the connection credentials in Secrets Manager.
- Run migrations once per release through the existing GitHub Actions and SSM deployment path. Keep schema changes compatible with image rollback. Add PostgreSQL to local and CI workflows.
- Verify that CloudFront forwards the cookies, headers, and request methods Django needs for authenticated requests and disables caching for private API responses. Configure account email delivery for invitations and password resets.

## 5. Verify the workflow

- Sign in as an admin, invite a driver, and assign a delivery. Sign in as that driver on a mobile viewport, open the prefilled planner, save an ETA, report a delay, and mark the delivery complete. Verify each update appears on the admin board.
- Check that a driver cannot read or update another driver’s job, that admins cannot access another company’s records, and that deactivated drivers lose fleet access. Verify that jobs and history survive an app restart.

This plan uses manual check-ins and driver-confirmed ETAs for the first release.

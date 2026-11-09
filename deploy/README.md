# AWS deployment — no purchased domain

**Temporary pause:** the EC2 instance is stopped and `DEPLOY_ENABLED=false`. The verification below describes the successful deployment before the pause. The address will be unavailable until the instance is restarted. See [CI/CD and releases](CICD.md) for GitHub publishing, deployment and rollback.

Current deployment: [TruckMate](https://d1fmez7o5mdp8o.cloudfront.net), stack `truckmate`, Sydney (`ap-southeast-2`). Public HTTPS, frontend assets, redirect, a live three-route analysis and all 49 corridor time positions passed on November 9, 2026. The container is healthy, runs as a non-root user, has no embedded AWS access keys and removes its temporary ECR login files. The briefing check returned the calculated fallback. Bedrock is configured but inference is blocked by zero applied Nova Micro token quotas; configuration flags are not proof of provider availability.

It uses EC2 for the container and a default CloudFront HTTPS hostname. The origin is HTTP inside this architecture; viewer-to-CloudFront traffic is HTTPS. Do not describe this as end-to-end TLS. The EC2 security group only permits CloudFront's origin-facing prefix list, and an additional secret origin header protects application access.

## Before deployment

1. Configure a local AWS CLI/profile with sufficient deployment permissions. The server later uses an instance role, never embedded AWS access keys.
2. Verify credit expiry/eligibility and current charges for EC2, EBS, IPv4, Secrets Manager and CloudFront. Set billing notifications. Budget notifications are not a hard spend cap.
3. Fill `.env` with TomTom, optional Groq, and desired Bedrock settings. Verify the model in the selected region. Do not share the file or commit it.
4. Run backend/component tests and the production build. Run visual/browser QA before submission; it is pending in this session.
5. Ensure Docker works. The deployment now uses **private Amazon ECR** in the same AWS account and region as the application. The EC2 instance obtains temporary registry credentials through its IAM role; no access keys or registry passwords are embedded in the image.

## Build and publish the private image

Set `AWS_REGION=ap-southeast-2` in the existing private `.env` file for this project's Sydney home region. Both helpers read this default; `--region` overrides it. Changing the console's region selector does not change the home region assigned to an AWS project account.

The publisher creates the private `truckmate` repository if needed, uses immutable tags for a new repository, builds for the EC2 instance's Linux AMD64 architecture, and prints an immutable image digest. The repository is encrypted with ECR's AES256 option. Registry credentials are passed to Docker on standard input in an isolated temporary configuration directory and removed when the publisher exits. It leaves the user's normal Docker configuration alone.

```powershell
.\.venv\Scripts\python.exe deploy\publish.py
.\.venv\Scripts\python.exe deploy\publish.py --push
```

The first command only prints a plan, with no AWS calls or Docker changes. The second creates an AWS repository if necessary and uploads the image. Add `--profile YOUR_PROFILE` to both helpers if using a named AWS profile; omit it for the configured default credentials. Copy the digest URI printed by the publisher into `$truckmateImage` for the following commands. It looks like `123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/truckmate@sha256:<64 hex digits>`.

Local deployment permissions include STS identity checks, private ECR repository creation and image push/read, EC2/VPC discovery, CloudFormation, IAM role/profile creation and passing, Secrets Manager, and SSM command execution. Runtime permissions are separate: only SSM, the settings secret, the selected Bedrock model and pull access to the selected private repository. `ecr:GetAuthorizationToken` requires `Resource: '*'`; repository read actions are scoped to the one repository ARN. Organization-level explicit denies cannot be overridden by adding user/group permissions.

The former GHCR workflow has been replaced by the private ECR release pipeline. CI checks do not require AWS credentials or invoke upstream routing/weather/AI APIs. See [the CI/CD guide](CICD.md).

## Prepare without cloud changes

```powershell
.\.venv\Scripts\python.exe deploy\deploy.py --image $truckmateImage
```

This prints the resource plan without AWS calls. Review the image, credits, account, region and resource costs first.

## Launch

```powershell
.\.venv\Scripts\python.exe deploy\deploy.py --image $truckmateImage --deploy
```

The helper rejects public/non-ECR images, other-region images and repositories owned by another account. It verifies the image exists, resolves any supplied tag to a digest, and validates the template before changing secrets or provisioning resources. It finds an existing default VPC/public subnet and CloudFront prefix list. If needed supply `--vpc-id` and `--subnet-id`; the subnet must have an internet route and DNS support. It stores settings in Secrets Manager, creates/updates CloudFormation, waits for SSM, starts the container, checks local and public HTTPS health and prints the generated HTTPS URL. The instance authenticates to ECR on every application start, then discards its temporary registry credentials.

CloudFormation's instance role permits SSM, reading the one settings secret, and invoking the selected regional foundation model. Cross-region inference profiles require an intentional IAM/template change. The EC2 instance uses required IMDSv2, 20 GiB encrypted gp3 storage, standard CPU credits and no SSH ingress. One Gunicorn worker with four threads keeps the in-memory analysis/quota cache shared.

Amazon Linux 2023 names its CLI package `awscli-2`. After each stack change, the helper reapplies the instance's configured bootstrap through SSM before restarting the application. This keeps startup script updates synchronized and allows recovery from a failed first-boot install; EC2 does not automatically rerun first-boot user data on an ordinary template update.

CloudFront caching is disabled for dynamic content, including geocoding query strings and capability flags. Future static caching can be configured separately. Credentials are never included in frontend build variables.

## Verify the hosted result

- `/api/health` returns `{"status":"ok"}` over the public HTTPS URL.
- The live planner loads without an automatic analysis request; synthetic requests are not exposed by the public API.
- Three representative alternatives are inspected; fewer available routes are handled honestly.
- Any analysis where all routes are blocked has no recommendation.
- Both AI provider paths and the calculated fallback behave as expected.
- The forecast slider performs no request per change.
- The application works after a container restart and reports expired analyses clearly.
- Check AWS cost/credit usage and application logs.

Model availability/authorization does not prove inference works. Nova Micro is already available and authorized in this account, but its applied on-demand and daily token quotas in Sydney are zero. The retired model-access request page is not an activation step for this Amazon model. Use Service Quotas in `ap-southeast-2`, select Amazon Bedrock, and find **Cross-region model inference tokens per minute for Amazon Nova Micro** (`L-DC7FF66C`, adjustable). Choose **Request increase at account-level**. AWS documents this adjustable quota as the entry point for requesting increases to regional on-demand capacity as well; mention the zero regional on-demand and daily allowances in any resulting request correspondence. This does not require changing the application's model ID to a cross-region profile. See [AWS's current runtime quota instructions](https://docs.aws.amazon.com/bedrock/latest/userguide/quotas-runtime.html) and [Service Quotas request steps](https://docs.aws.amazon.com/servicequotas/latest/userguide/request-quota-increase.html). Approval is not guaranteed; verify a real inference call after the applied quota changes. The existing Groq/calculated fallback can remain in use while the account's Bedrock allowance is resolved.

The helper's EC2 health check is not a substitute for this public verification. A failed deployment can leave billable resources provisioned; inspect the stack before retrying.

## Updates and rollback

Use the same helper and stack name with a new verified image digest. To roll back, redeploy the previous digest. Image/config changes are applied through SSM after the stack update. Keep the previous digest and a deployment record. Do not delete resources to perform a normal rollback.

If configuration is updated only, the helper writes a new secret version and restarts the application. API analysis IDs and in-memory caches expire across restarts by design.

The private repository is managed by the publisher, outside the application CloudFormation stack. Deleting the stack does not delete repository images or the application settings secret. Inspect and remove these separately when permanently retiring the application; retain previous image digests when you still need rollback.

## Bedrock quota request status

The API reports `L-DC7FF66C` as adjustable even though the regional on-demand/daily entries are not adjustable. AWS rejected 10,000 tokens/minute because requests must exceed the published default of 400,000. With the owner's approval, a request for 400,001 was submitted and a Support case opened. This is an allowance request, not a purchase or a guarantee of approval. The application limits remain in place. The zero on-demand/daily allowances should also be addressed in the resulting case before considering Bedrock functional.

## Submission assets

Publish the repository and hosted URL, then record the walkthrough in `docs/walkthrough.md`. No domain registration or Route 53 hosted zone is needed.

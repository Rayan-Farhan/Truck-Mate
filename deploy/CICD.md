# CI/CD and releases

The container stays in private Amazon ECR. GitHub Releases hold version notes and `image.json` (source commit, immutable image reference and publication/deployment status), not the container itself. GitHub Packages therefore remains empty.

## Verification

`ci.yml` verifies pull requests and `main`: pinned actionlint validates workflow syntax, backend and deployment tests run, frontend tests/build and controlled desktop/mobile Playwright checks run, and the built Linux AMD64 container must serve health and frontend assets as a non-root user without embedded AWS keys. Browser tests mock API responses; no upstream routing/weather/AI services are invoked by CI.

The release workflow reuses verification, builds/checks/pushes its release image once, and deploys those exact bytes when production deployment is enabled. Windows-local shell tests are skipped there but run on the Linux CI runner. They exercise the actual SSM shell body with fake service commands to check success, failed start, rollback, repeated deployment and protection against replacing a newer deployment.

## Bootstrap AWS and GitHub integration

```powershell
.\.venv\Scripts\python.exe deploy\setup_cicd.py --repo OWNER/REPOSITORY
.\.venv\Scripts\python.exe deploy\setup_cicd.py --repo OWNER/REPOSITORY --apply
```

Without `--apply` this makes no AWS/GitHub API calls. With it, the helper creates/updates the separate `truckmate-cicd` stack, which owns the GitHub OIDC provider (or reuses an existing one), two scoped roles and a constrained SSM deployment document. It reads GitHub's actual subject prefix, including immutable owner/repository IDs, instead of guessing the trust subject. No application settings or AWS access keys are copied to GitHub.

The `release` and `production` GitHub environments only allow `main` and `v*` tags. Repository variables hold the role ARNs, region, repository and application stack. The publishing role can push/read only the existing private repository. The deployment role can inspect the application stack and send only the constrained deployment document to instances tagged with that stack's application name. It cannot create infrastructure, change IAM or start EC2.

`DEPLOY_ENABLED` is deliberately reset to `false` when bootstrapping. Bootstrap does not change the existing application instance's state.

## Publish a release

Update the frontend package version and lockfile together, for example by running `npm version 1.0.1 --no-git-tag-version` from `frontend`. Commit and merge the change to `main`, then push a matching annotated tag:

```powershell
git tag -a v1.0.1 -m "TruckMate v1.0.1"
git push origin v1.0.1
```

The tag must match `frontend/package.json` and point to a commit already on `main`. The workflow tests that exact commit, checks the built container and uploads it to private ECR with immutable tags. When deployment is enabled, it deploys and verifies public health before publishing the GitHub Release. While paused, it skips deployment and publishes the Release with `deployment: paused` in its attached `image.json`.

No image is uploaded to GitHub Packages or public Actions artifacts. Existing published releases are not overwritten; use Deploy to redeploy or roll back instead. Distinct image tags include the workflow run/attempt, and the immutable image digest is the deployment identity.

## Resume production deployment

First start the EC2 instance and verify it is running. Then enable deployment and select a published release:

```powershell
gh variable set DEPLOY_ENABLED --body true --repo OWNER/REPOSITORY
gh workflow run deploy.yml --ref main -f release_tag=v1.0.1 --repo OWNER/REPOSITORY
```

The helper refuses to start a stopped instance even if deployment is enabled. Production configuration/infrastructure changes still use the separately privileged local `deploy/deploy.py`; release deployments only change the existing application's image using `deploy/release.py`.

The constrained SSM command serializes changes, saves the previous digest and restores it if the candidate fails locally. The release helper also requests rollback if public HTTPS/frontend checks fail. A failed rollback is reported as a failed deployment. GitHub concurrency prevents overlapping production runs. This remains a single-instance deployment with restart downtime.

## Rollback

Run the same Deploy workflow with an earlier published release tag. Its `image.json` selects the original immutable image, which is not rebuilt. The asset's deployment field records the state at publication; GitHub's production environment shows subsequent deployment runs.

## Operational limits

Production execution of the new release command still needs a live deployment verification when the instance is resumed. Offline safety tests and successful release publishing do not replace that check. Bedrock's pending quota request is independent of CI/CD; a successful release does not prove AI inference is available.

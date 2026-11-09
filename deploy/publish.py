"""Build and publish TruckMate to private ECR. No changes without --push."""

import argparse
import base64
import json
from datetime import datetime, timezone
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile

import boto3
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent.parent


def main():
    env = dotenv_values(ROOT / ".env")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--region", default=env.get("AWS_REGION") or "us-east-1")
    parser.add_argument("--profile")
    parser.add_argument("--repository", default="truckmate")
    parser.add_argument(
        "--existing-only",
        action="store_true",
        help="Require an existing repository (used by CI's scoped role)",
    )
    parser.add_argument("--revision", help="Source commit SHA to attach to the image")
    parser.add_argument(
        "--metadata-file",
        type=Path,
        help="Write the published immutable image reference as JSON",
    )
    parser.add_argument(
        "--tag",
        default=datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
        + "-"
        + secrets.token_hex(3),
    )
    parser.add_argument(
        "--push",
        action="store_true",
        help="Create the private repository if needed, build and upload the image",
    )
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9]+(?:[._/-][a-z0-9]+)*", args.repository):
        parser.error("Invalid ECR repository name.")
    if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}", args.tag):
        parser.error("Invalid image tag.")
    if args.revision and not re.fullmatch(r"[a-f0-9]{40}", args.revision):
        parser.error("Revision must be a full commit SHA.")
    print(f"Plan: build linux/amd64 and publish to PRIVATE ECR in {args.region}.")
    print(f"Repository: {args.repository}. Tag: {args.tag}.")
    if not args.push:
        print(
            "Preparation only: no AWS calls, builds or uploads. Add --push to publish."
        )
        return
    subprocess.run(["docker", "info"], check=True, stdout=subprocess.DEVNULL)
    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    account = session.client("sts").get_caller_identity()["Account"]
    ecr = session.client("ecr")
    try:
        repository = ecr.describe_repositories(repositoryNames=[args.repository])[
            "repositories"
        ][0]
    except ecr.exceptions.RepositoryNotFoundException:
        if args.existing_only:
            parser.error(
                "The private ECR repository must be provisioned before CI publishes."
            )
        repository = ecr.create_repository(
            repositoryName=args.repository,
            imageTagMutability="IMMUTABLE",
            encryptionConfiguration={"encryptionType": "AES256"},
            tags=[{"Key": "Project", "Value": "TruckMate"}],
        )["repository"]
    uri = repository["repositoryUri"]
    tagged = f"{uri}:{args.tag}"
    build = ["docker", "build", "--platform", "linux/amd64", "-t", tagged]
    if args.revision:
        build += ["--label", "org.opencontainers.image.revision=" + args.revision]
    subprocess.run(
        build + ["."],
        cwd=ROOT,
        check=True,
    )
    # Push precisely the image that passed these runtime checks.
    subprocess.run(
        [sys.executable, str(ROOT / "deploy" / "check_image.py"), tagged], check=True
    )
    auth = ecr.get_authorization_token(registryIds=[account])["authorizationData"][0]
    username, password = (
        base64.b64decode(auth["authorizationToken"]).decode().split(":", 1)
    )
    # Isolate registry credentials from the user's Docker config and erase them on exit.
    with tempfile.TemporaryDirectory(prefix="truckmate-ecr-") as auth_dir:
        subprocess.run(
            [
                "docker",
                "--config",
                auth_dir,
                "login",
                "--username",
                username,
                "--password-stdin",
                uri.split("/", 1)[0],
            ],
            input=password,
            text=True,
            check=True,
            capture_output=True,
        )
        subprocess.run(["docker", "--config", auth_dir, "push", tagged], check=True)
    details = ecr.describe_images(
        repositoryName=args.repository, imageIds=[{"imageTag": args.tag}]
    )["imageDetails"][0]
    image = f"{uri}@{details['imageDigest']}"
    if args.metadata_file:
        args.metadata_file.parent.mkdir(parents=True, exist_ok=True)
        args.metadata_file.write_text(
            json.dumps(
                {
                    "image": image,
                    "tag": args.tag,
                    "revision": args.revision,
                    "region": args.region,
                },
                indent=2,
            )
            + "\n"
        )
    print("Private image published:", image)
    profile = f" --profile {args.profile}" if args.profile else ""
    print("Prepare deployment (no cloud changes):")
    print(
        f".\\.venv\\Scripts\\python.exe deploy\\deploy.py --image {image} --region {args.region}{profile}"
    )
    print(
        "Add --deploy to launch. The repository and uploaded image remain until explicitly deleted."
    )


if __name__ == "__main__":
    main()

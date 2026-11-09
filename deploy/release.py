"""Deploy a fixed private image to the existing stack, with public-health rollback.

No secrets are loaded by CI. The instance role loads its settings on restart.
Stopped instances are never started by this tool.
"""

import argparse
import json
from pathlib import Path
import re
import time

import boto3
from botocore.exceptions import WaiterError
import httpx

try:
    from .deploy import private_ecr_image
except ImportError:
    from deploy import private_ecr_image


def verify_public(url, attempts=12):
    with httpx.Client(timeout=10, follow_redirects=False) as client:
        for attempt in range(attempts):
            try:
                health = client.get(url + "/api/health")
                page = client.get(url + "/")
                assets = re.findall(r'(?:src|href)="(/assets/[^\"]+)"', page.text)
                if (
                    health.status_code == 200
                    and health.json() == {"status": "ok"}
                    and page.status_code == 200
                    and assets
                ):
                    if all(
                        client.get(url + asset).status_code == 200 for asset in assets
                    ):
                        return
            except (httpx.HTTPError, ValueError):
                pass
            if attempt + 1 < attempts:
                time.sleep(5)
    raise RuntimeError("Public HTTPS health/frontend checks failed")


def run_command(ssm, instance, document, image, action):
    command = ssm.send_command(
        InstanceIds=[instance],
        DocumentName=document,
        Parameters={"ImageUri": [image], "Action": [action]},
        TimeoutSeconds=60,
    )["Command"]["CommandId"]
    try:
        ssm.get_waiter("command_executed").wait(
            CommandId=command,
            InstanceId=instance,
            WaiterConfig={"Delay": 5, "MaxAttempts": 125},
        )
    except WaiterError as exc:
        # The constrained document restores the previous image on local failure.
        raise RuntimeError(
            f"SSM {action} failed; inspect command {command}. The document attempts local rollback."
        ) from exc
    return command


def deploy_release(session, stack_name, image, region):
    details = private_ecr_image(image, region)
    if not details["digest"]:
        raise ValueError("Release deployments require an immutable sha256 digest")
    account = session.client("sts").get_caller_identity()["Account"]
    if details["account"] != account:
        raise ValueError("Image belongs to another AWS account")
    stack = session.client("cloudformation").describe_stacks(StackName=stack_name)[
        "Stacks"
    ][0]
    if stack["StackStatus"] not in [
        "CREATE_COMPLETE",
        "UPDATE_COMPLETE",
        "UPDATE_ROLLBACK_COMPLETE",
    ]:
        raise RuntimeError("Application stack is not in a stable state")
    outputs = {item["OutputKey"]: item["OutputValue"] for item in stack["Outputs"]}
    instance = outputs["InstanceId"]
    state = session.client("ec2").describe_instances(InstanceIds=[instance])[
        "Reservations"
    ][0]["Instances"][0]["State"]["Name"]
    if state != "running":
        raise RuntimeError(
            f"TruckMate is {state}; release deployment will not start a paused instance."
        )
    ssm = session.client("ssm")
    document = stack_name + "-deploy-image"
    command = run_command(ssm, instance, document, image, "deploy")
    try:
        verify_public(outputs["Url"])
    except Exception as original:
        try:
            rollback = run_command(ssm, instance, document, image, "rollback")
            verify_public(outputs["Url"])
        except Exception as rollback_error:
            raise RuntimeError(
                "Release verification and rollback verification failed; inspect the deployment immediately."
            ) from rollback_error
        raise RuntimeError(
            f"Release verification failed; previous image restored (rollback command {rollback})."
        ) from original
    return {
        "image": image,
        "url": outputs["Url"],
        "region": region,
        "stack": stack_name,
        "command_id": command,
        "status": "deployed",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--stack", default="truckmate")
    parser.add_argument("--profile")
    parser.add_argument("--deploy", action="store_true")
    parser.add_argument("--metadata-file", type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9-]{0,39}", args.stack):
        parser.error("Invalid stack name")
    details = private_ecr_image(args.image, args.region)
    if not details["digest"]:
        parser.error("Use an immutable sha256 image digest")
    if not args.deploy:
        print(
            f"Plan only: deploy {args.image} to {args.stack} in {args.region}. No AWS calls or changes."
        )
        return
    record = deploy_release(
        boto3.Session(profile_name=args.profile, region_name=args.region),
        args.stack,
        args.image,
        args.region,
    )
    if args.metadata_file:
        args.metadata_file.parent.mkdir(parents=True, exist_ok=True)
        args.metadata_file.write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps(record))


if __name__ == "__main__":
    main()

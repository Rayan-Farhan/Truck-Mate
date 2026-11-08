"""Prepare/launch the single-instance AWS stack. No changes without --deploy.

Run from the project venv. Uses the AWS credential chain; never embeds access keys.
"""

import argparse
from pathlib import Path
import re
import secrets
import time

import boto3
import httpx
from botocore.exceptions import ClientError
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--image",
        required=True,
        help="Public GHCR/ECR image URI, preferably pinned by digest",
    )
    parser.add_argument("--stack", default="truckmate")
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--profile")
    parser.add_argument("--vpc-id")
    parser.add_argument("--subnet-id")
    parser.add_argument(
        "--deploy", action="store_true", help="Create/update billed AWS resources"
    )
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9-]{0,39}", args.stack):
        parser.error("Use a simple stack name of at most 40 characters.")
    if not re.fullmatch(r"[a-zA-Z0-9./:@_-]+", args.image):
        parser.error("Invalid image URI.")
    env = {k: v for k, v in dotenv_values(ROOT / ".env").items() if v is not None}
    print(
        "Plan: one t3.small EC2, 20 GiB encrypted EBS, public IPv4, Secrets Manager, CloudFront and runtime IAM role."
    )
    print(
        "Public HTTPS uses an AWS-generated hostname. No domain registration. Usage consumes eligible AWS credits."
    )
    if not args.deploy:
        print(
            "Preparation only: no AWS calls or resource changes. Add --deploy when credentials, image and costs are reviewed."
        )
        return
    if not env.get("TOMTOM_API_KEY"):
        parser.error(
            "Fill TOMTOM_API_KEY in .env before deploying the live application."
        )
    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    session.client(
        "sts"
    ).get_caller_identity()  # Credential preflight, no account identifiers logged.
    ec2 = session.client("ec2")
    vpcs = (
        ec2.describe_vpcs(Filters=[{"Name": "is-default", "Values": ["true"]}])["Vpcs"]
        if not args.vpc_id
        else []
    )
    vpc = args.vpc_id or (vpcs[0]["VpcId"] if vpcs else None)
    if not vpc:
        parser.error(
            "No default VPC. Supply --vpc-id and --subnet-id for an existing public subnet."
        )
    subnets = ec2.describe_subnets(Filters=[{"Name": "vpc-id", "Values": [vpc]}])[
        "Subnets"
    ]
    subnet = args.subnet_id or next(
        (s["SubnetId"] for s in subnets if s.get("MapPublicIpOnLaunch")), None
    )
    if not subnet:
        parser.error("An existing public subnet with internet access is required.")
    prefixes = ec2.describe_managed_prefix_lists(
        Filters=[
            {
                "Name": "prefix-list-name",
                "Values": ["com.amazonaws.global.cloudfront.origin-facing"],
            }
        ]
    )["PrefixLists"]
    if not prefixes:
        parser.error(
            "CloudFront origin-facing managed prefix list unavailable in this region."
        )
    sm = session.client("secretsmanager")
    name = args.stack + "/application-settings"
    origin_token = secrets.token_urlsafe(40)
    try:
        existing = sm.get_secret_value(SecretId=name)
        for line in existing["SecretString"].splitlines():
            if line.startswith("ORIGIN_VERIFY_TOKEN="):
                origin_token = line.partition("=")[2]
    except sm.exceptions.ResourceNotFoundException:
        existing = None
    env.update(
        DJANGO_SECRET_KEY=env.get("DJANGO_SECRET_KEY") or secrets.token_urlsafe(48),
        DJANGO_DEBUG="false",
        ORIGIN_VERIFY_TOKEN=origin_token,
    )
    # Keep AWS access credentials out of the deployed dotenv: runtime uses its instance role.
    for key in [
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_PROFILE",
    ]:
        env.pop(key, None)
    if any("\n" in value or "\r" in value for value in env.values()):
        parser.error("Configuration values must be single-line.")
    serialized = "\n".join(f"{key}={value}" for key, value in env.items())
    arn = (
        sm.put_secret_value(SecretId=name, SecretString=serialized)["ARN"]
        if existing
        else sm.create_secret(Name=name, SecretString=serialized)["ARN"]
    )
    cf = session.client("cloudformation")
    parameters = {
        "VpcId": vpc,
        "SubnetId": subnet,
        "CloudFrontPrefixListId": prefixes[0]["PrefixListId"],
        "ImageUri": args.image,
        "SettingsSecretArn": arn,
        "OriginToken": origin_token,
        "BedrockModelId": env.get("BEDROCK_MODEL_ID", "amazon.nova-micro-v1:0"),
    }
    request = {
        "StackName": args.stack,
        "TemplateBody": (ROOT / "deploy" / "aws.yaml").read_text(),
        "Parameters": [
            {"ParameterKey": k, "ParameterValue": v} for k, v in parameters.items()
        ],
        "Capabilities": ["CAPABILITY_IAM"],
    }
    try:
        cf.describe_stacks(StackName=args.stack)
        action = "update"
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ValidationError":
            raise
        action = "create"
    try:
        getattr(cf, action + "_stack")(**request)
        print("Waiting for infrastructure deployment. No credentials will be printed.")
        cf.get_waiter("stack_" + action + "_complete").wait(
            StackName=args.stack, WaiterConfig={"Delay": 15, "MaxAttempts": 100}
        )
    except ClientError as exc:
        if "No updates are to be performed" not in str(exc):
            raise
    stack = cf.describe_stacks(StackName=args.stack)["Stacks"][0]
    outputs = {item["OutputKey"]: item["OutputValue"] for item in stack["Outputs"]}
    ssm = session.client("ssm")
    instance = outputs["InstanceId"]
    for attempt in range(40):
        info = ssm.describe_instance_information(
            Filters=[{"Key": "InstanceIds", "Values": [instance]}]
        )["InstanceInformationList"]
        if info and info[0].get("PingStatus") == "Online":
            break
        time.sleep(10)
    else:
        raise RuntimeError(
            "SSM did not become ready. Check EC2 bootstrap logs; infrastructure remains provisioned."
        )
    command = ssm.send_command(
        InstanceIds=[instance],
        DocumentName="AWS-RunShellScript",
        Parameters={
            "commands": [
                "set -eu",
                "for i in $(seq 1 30); do test -x /opt/truckmate/start.sh && break; sleep 2; done",
                "test -x /opt/truckmate/start.sh",
                f"printf '%s\\n' '{args.image}' > /opt/truckmate/image-uri",
                "systemctl restart truckmate",
                "for i in $(seq 1 30); do curl --fail --silent http://localhost/api/health && exit 0; sleep 2; done; exit 1",
            ],
            "executionTimeout": ["180"],
        },
    )["Command"]["CommandId"]
    ssm.get_waiter("command_executed").wait(
        CommandId=command,
        InstanceId=instance,
        WaiterConfig={"Delay": 5, "MaxAttempts": 45},
    )
    for attempt in range(8):
        try:
            response = httpx.get(outputs["Url"] + "/api/health", timeout=10)
            if response.status_code == 200 and response.json().get("status") == "ok":
                break
        except (httpx.HTTPError, ValueError):
            pass
        time.sleep(5)
    else:
        raise RuntimeError(
            "Local container is healthy, but public CloudFront health is not verified. Inspect the origin configuration; resources remain provisioned."
        )
    print("Local and public HTTPS health checks passed. Public URL:", outputs["Url"])
    print(
        "Review the hosted application and credit usage. Roll back by redeploying a previously verified image digest."
    )


if __name__ == "__main__":
    main()

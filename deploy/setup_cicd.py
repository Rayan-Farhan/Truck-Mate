"""Provision scoped GitHub OIDC integration. No changes without --apply.

This does not start or modify the application instance. DEPLOY_ENABLED is set
to false so publishing releases cannot accidentally restart the paused site.
"""

import argparse
import json
from pathlib import Path
import re
import subprocess

import boto3
from botocore.exceptions import ClientError
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent.parent


def github_api(path, method="GET", body=None):
    command = ["gh", "api", path, "--method", method]
    if body is not None:
        command += ["--input", "-"]
    output = subprocess.check_output(
        command, input=json.dumps(body) if body is not None else None, text=True
    )
    return json.loads(output) if output.strip() else {}


def configure_github(repo, variables):
    for name in ["release", "production"]:
        endpoint = f"repos/{repo}/environments/{name}"
        github_api(
            endpoint,
            "PUT",
            {
                "deployment_branch_policy": {
                    "protected_branches": False,
                    "custom_branch_policies": True,
                }
            },
        )
        policies = github_api(endpoint + "/deployment-branch-policies")[
            "branch_policies"
        ]
        existing = {(item["name"], item["type"]) for item in policies}
        for pattern, kind in [("main", "branch"), ("v*", "tag")]:
            if (pattern, kind) not in existing:
                github_api(
                    endpoint + "/deployment-branch-policies",
                    "POST",
                    {"name": pattern, "type": kind},
                )
    for name, value in variables.items():
        subprocess.run(
            ["gh", "variable", "set", name, "--repo", repo, "--body", value], check=True
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="GitHub OWNER/REPOSITORY")
    parser.add_argument(
        "--region",
        default=dotenv_values(ROOT / ".env").get("AWS_REGION") or "ap-southeast-2",
    )
    parser.add_argument("--stack", default="truckmate")
    parser.add_argument("--repository", default="truckmate")
    parser.add_argument("--profile")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repo):
        parser.error("Invalid GitHub repository")
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9-]{0,39}", args.stack):
        parser.error("Invalid application stack")
    print(
        f"Plan: scoped OIDC roles, a constrained SSM deployment document, and GitHub release/production environments for {args.repo} in {args.region}."
    )
    print(
        "Production deployments will be disabled. The EC2 instance will remain in its existing state."
    )
    if not args.apply:
        print("Preparation only: no AWS or GitHub API calls. Add --apply to configure.")
        return
    prefix = github_api(f"repos/{args.repo}/actions/oidc/customization/sub").get(
        "sub_claim_prefix"
    )
    if not prefix:
        raise RuntimeError(
            "GitHub did not return its subject prefix; inspect OIDC customization before configuring trust."
        )
    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    cf = session.client("cloudformation")
    stack_name = args.stack + "-cicd"
    try:
        existing_stack = cf.describe_stacks(StackName=stack_name)["Stacks"][0]
    except ClientError as exc:
        if (
            exc.response["Error"]["Code"] != "ValidationError"
            or "does not exist" not in exc.response["Error"]["Message"]
        ):
            raise
        existing_stack = None
    if existing_stack:
        provider = next(
            item["ParameterValue"]
            for item in existing_stack["Parameters"]
            if item["ParameterKey"] == "ExistingOidcProviderArn"
        )
    else:
        providers = session.client("iam").list_open_id_connect_providers()[
            "OpenIDConnectProviderList"
        ]
        provider = next(
            (
                item["Arn"]
                for item in providers
                if item["Arn"].endswith("/token.actions.githubusercontent.com")
            ),
            "",
        )
    template = (ROOT / "deploy" / "cicd.yaml").read_text()
    cf.validate_template(TemplateBody=template)
    parameters = {
        "AppStackName": args.stack,
        "EcrRepositoryName": args.repository,
        "GitHubSubjectPrefix": prefix,
        "ExistingOidcProviderArn": provider,
    }
    request = {
        "StackName": stack_name,
        "TemplateBody": template,
        "Parameters": [
            {"ParameterKey": key, "ParameterValue": value}
            for key, value in parameters.items()
        ],
        "Capabilities": ["CAPABILITY_NAMED_IAM"],
    }
    action = "update" if existing_stack else "create"
    try:
        getattr(cf, action + "_stack")(**request)
        print(
            "Waiting for OIDC integration stack (application instance is unchanged).",
            flush=True,
        )
        cf.get_waiter("stack_" + action + "_complete").wait(
            StackName=stack_name, WaiterConfig={"Delay": 5, "MaxAttempts": 120}
        )
    except ClientError as exc:
        if "No updates are to be performed" not in exc.response["Error"]["Message"]:
            raise
    stack = cf.describe_stacks(StackName=stack_name)["Stacks"][0]
    outputs = {item["OutputKey"]: item["OutputValue"] for item in stack["Outputs"]}
    configure_github(
        args.repo,
        {
            "AWS_REGION": args.region,
            "ECR_REPOSITORY": args.repository,
            "APP_STACK": args.stack,
            "AWS_PUBLISH_ROLE_ARN": outputs["PublishRoleArn"],
            "AWS_DEPLOY_ROLE_ARN": outputs["DeployRoleArn"],
            "DEPLOY_ENABLED": "false",
        },
    )
    print(
        "GitHub OIDC configured. DEPLOY_ENABLED=false; no static AWS credentials were copied to GitHub."
    )


if __name__ == "__main__":
    main()

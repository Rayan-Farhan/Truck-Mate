"""Offline checks for private-image boundaries and safe preparation mode."""

import base64
import contextlib
import io
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

from deploy import deploy, publish


REGION = "ap-southeast-2"
REGISTRY = f"123456789012.dkr.ecr.{REGION}.amazonaws.com"
DIGEST = "sha256:" + "a" * 64


class PrivateImageTests(unittest.TestCase):
    def test_accepts_tag_and_digest_in_selected_region(self):
        tagged = deploy.private_ecr_image(f"{REGISTRY}/team/truckmate:v1", REGION)
        self.assertEqual(tagged["repository"], "team/truckmate")
        self.assertEqual(tagged["tag"], "v1")
        pinned = deploy.private_ecr_image(f"{REGISTRY}/truckmate@{DIGEST}", REGION)
        self.assertEqual(pinned["digest"], DIGEST)

    def test_rejects_public_images_wrong_regions_and_shell_input(self):
        for image in [
            "ghcr.io/owner/truckmate:v1",
            "public.ecr.aws/alias/truckmate:v1",
            f"{REGISTRY}/truckmate",
            f"{REGISTRY}/truckmate:v1;whoami",
            f"{REGISTRY}/truckmate:v1\n",
            f"{REGISTRY}/truckmate@sha256:bad",
            "123456789012.dkr.ecr.us-east-1.amazonaws.com/truckmate:v1",
        ]:
            with self.subTest(image=image), self.assertRaises(ValueError):
                deploy.private_ecr_image(image, REGION)

    @patch.object(deploy, "dotenv_values", return_value={"AWS_REGION": REGION})
    @patch.object(
        deploy.boto3, "Session", side_effect=AssertionError("AWS call in dry run")
    )
    def test_deploy_preview_uses_env_region_without_aws(self, session, env):
        output = io.StringIO()
        with patch(
            "sys.argv", ["deploy.py", "--image", f"{REGISTRY}/truckmate:v1"]
        ), contextlib.redirect_stdout(output):
            deploy.main()
        self.assertIn(REGION, output.getvalue())
        self.assertIn("Preparation only", output.getvalue())
        session.assert_not_called()

    @patch.object(
        deploy,
        "dotenv_values",
        return_value={"AWS_REGION": REGION, "TOMTOM_API_KEY": "test"},
    )
    def test_different_account_rejected_before_ecr_or_secret_changes(self, env):
        session = Mock()
        session.client.return_value.get_caller_identity.return_value = {
            "Account": "999999999999"
        }
        with patch.object(deploy.boto3, "Session", return_value=session), patch(
            "sys.argv", ["deploy.py", "--image", f"{REGISTRY}/truckmate:v1", "--deploy"]
        ), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(
            io.StringIO()
        ), self.assertRaises(
            SystemExit
        ):
            deploy.main()
        session.client.assert_called_once_with("sts")


class PublisherTests(unittest.TestCase):
    @patch.object(publish, "dotenv_values", return_value={"AWS_REGION": REGION})
    @patch.object(
        publish.boto3, "Session", side_effect=AssertionError("AWS call in dry run")
    )
    @patch.object(
        publish.subprocess, "run", side_effect=AssertionError("Docker call in dry run")
    )
    def test_preview_does_not_build_or_publish(self, run, session, env):
        with patch("sys.argv", ["publish.py"]), contextlib.redirect_stdout(
            io.StringIO()
        ):
            publish.main()
        run.assert_not_called()
        session.assert_not_called()

    @patch.object(publish, "dotenv_values", return_value={"AWS_REGION": REGION})
    def test_upload_keeps_password_off_command_line_and_erases_auth(self, env):
        uri = f"{REGISTRY}/truckmate"
        password = "test-registry-password"
        ecr = Mock()
        ecr.describe_repositories.return_value = {
            "repositories": [{"repositoryUri": uri}]
        }
        ecr.get_authorization_token.return_value = {
            "authorizationData": [
                {
                    "authorizationToken": base64.b64encode(
                        f"AWS:{password}".encode()
                    ).decode()
                }
            ]
        }
        ecr.describe_images.return_value = {"imageDetails": [{"imageDigest": DIGEST}]}
        sts = Mock()
        sts.get_caller_identity.return_value = {"Account": "123456789012"}
        session = Mock()
        session.client.side_effect = lambda service: {"sts": sts, "ecr": ecr}[service]
        auth_dirs = []

        def run(command, **kwargs):
            self.assertNotIn(password, " ".join(command))
            if "login" in command:
                self.assertEqual(kwargs["input"], password)
                auth_dir = Path(command[command.index("--config") + 1])
                self.assertTrue(auth_dir.is_dir())
                auth_dirs.append(auth_dir)
            if "push" in command:
                self.assertEqual(
                    command[command.index("--config") + 1], str(auth_dirs[0])
                )
                self.assertTrue(auth_dirs[0].is_dir())

        output = io.StringIO()
        with patch.object(publish.boto3, "Session", return_value=session), patch.object(
            publish.subprocess, "run", side_effect=run
        ), patch(
            "sys.argv", ["publish.py", "--tag", "release-1", "--push"]
        ), contextlib.redirect_stdout(
            output
        ):
            publish.main()
        self.assertEqual(len(auth_dirs), 1)
        self.assertFalse(auth_dirs[0].exists())
        self.assertNotIn(password, output.getvalue())
        self.assertIn(f"{uri}@{DIGEST}", output.getvalue())


if __name__ == "__main__":
    unittest.main()

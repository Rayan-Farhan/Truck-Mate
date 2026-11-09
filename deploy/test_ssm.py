"""Exercise the real deployment shell script against fake service commands."""

import base64
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import unittest

REGISTRY = "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/truckmate"
OLD = REGISTRY + "@sha256:" + "a" * 64
NEW = REGISTRY + "@sha256:" + "b" * 64


def deployment_script():
    override = os.getenv("TRUCKMATE_TEST_DEPLOY_SCRIPT")
    if override:
        return base64.b64decode(override).decode()
    import yaml

    class Loader(yaml.SafeLoader):
        pass

    Loader.add_multi_constructor(
        "!",
        lambda loader, tag, node: (
            loader.construct_scalar(node)
            if isinstance(node, yaml.ScalarNode)
            else loader.construct_sequence(node)
        ),
    )
    template = yaml.load(
        (Path(__file__).parent / "cicd.yaml").read_text(), Loader=Loader
    )
    return template["Resources"]["DeploymentDocument"]["Properties"]["Content"][
        "mainSteps"
    ][0]["inputs"]["runCommand"][0]


@unittest.skipUnless(
    os.name == "posix" and shutil.which("bash") and shutil.which("flock"),
    "Deployment shell checks run on Linux",
)
class DeploymentShellTests(unittest.TestCase):
    def run_scenario(
        self, action="deploy", current=OLD, previous=OLD, candidate=NEW, failing=""
    ):
        with tempfile.TemporaryDirectory(prefix="truckmate-shell-") as directory:
            state = Path(directory)
            (state / "start.sh").write_text("#!/bin/sh\nexit 0\n")
            (state / "start.sh").chmod(0o700)
            (state / "image-uri").write_text(current + "\n")
            (state / "previous-image-uri").write_text(previous + "\n")
            mocks = """
systemctl() { test "$(cat "$STATE/image-uri")" != "$FAILING_IMAGE"; }
curl() { return 0; }
sleep() { return 0; }
docker() { printf '[{"Config":{"Image":"%s"},"State":{"Running":true}}]' "$(cat "$STATE/image-uri")"; }
"""
            script = deployment_script().replace(
                "STATE=/opt/truckmate", "STATE=" + shlex.quote(directory) + mocks
            )
            env = {
                **os.environ,
                "SSM_ImageUri": candidate,
                "SSM_Action": action,
                "FAILING_IMAGE": failing,
            }
            result = subprocess.run(
                ["bash"],
                input=script,
                text=True,
                capture_output=True,
                env=env,
                timeout=15,
            )
            return (
                result,
                (state / "image-uri").read_text().strip(),
                (state / "previous-image-uri").read_text().strip(),
            )

    def test_new_image_is_activated_and_previous_is_saved(self):
        result, current, previous = self.run_scenario()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((current, previous), (NEW, OLD))

    def test_local_start_failure_restores_previous_and_reports_failure(self):
        result, current, previous = self.run_scenario(failing=NEW)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(current, OLD)
        self.assertIn("LOCAL_HEALTH_ROLLBACK_OK", result.stdout)

    def test_public_check_rollback_restores_previous_image(self):
        result, current, previous = self.run_scenario(
            action="rollback", current=NEW, previous=OLD
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(current, OLD)

    def test_rollback_cannot_replace_a_newer_deployment(self):
        other = REGISTRY + "@sha256:" + "c" * 64
        result, current, previous = self.run_scenario(action="rollback", current=other)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(current, other)

    def test_repeated_same_image_never_rolls_back_an_unrelated_release(self):
        result, current, previous = self.run_scenario(current=NEW, previous=OLD)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((current, previous), (NEW, NEW))

    def test_wrong_repository_is_rejected_without_changing_image(self):
        result, current, previous = self.run_scenario(
            current=OLD.replace("/truckmate@", "/other@")
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("/other@", current)


if __name__ == "__main__":
    unittest.main()

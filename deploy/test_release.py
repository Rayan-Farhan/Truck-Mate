"""Release safety checks: paused instances and failed public verification."""

import contextlib
import io
import unittest
from unittest.mock import Mock, patch

from deploy import release

REGION = "ap-southeast-2"
IMAGE = "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/truckmate@sha256:" + "a" * 64


def session_for(state="running"):
    sts = Mock()
    sts.get_caller_identity.return_value = {"Account": "123456789012"}
    cf = Mock()
    cf.describe_stacks.return_value = {
        "Stacks": [
            {
                "StackStatus": "UPDATE_COMPLETE",
                "Outputs": [
                    {"OutputKey": "InstanceId", "OutputValue": "i-test"},
                    {
                        "OutputKey": "Url",
                        "OutputValue": "https://example.cloudfront.net",
                    },
                ],
            }
        ]
    }
    ec2 = Mock()
    ec2.describe_instances.return_value = {
        "Reservations": [{"Instances": [{"State": {"Name": state}}]}]
    }
    ssm = Mock()
    session = Mock()
    session.client.side_effect = lambda name: {
        "sts": sts,
        "cloudformation": cf,
        "ec2": ec2,
        "ssm": ssm,
    }[name]
    return session, ec2, ssm


class ReleaseTests(unittest.TestCase):
    def test_stopped_instance_is_not_started_or_modified(self):
        session, ec2, ssm = session_for("stopped")
        with self.assertRaisesRegex(RuntimeError, "will not start"):
            release.deploy_release(session, "truckmate", IMAGE, REGION)
        ec2.start_instances.assert_not_called()
        ssm.send_command.assert_not_called()

    def test_public_failure_rolls_back_and_fails_the_release(self):
        session, ec2, ssm = session_for()
        with patch.object(
            release, "run_command", side_effect=["deploy-command", "rollback-command"]
        ) as command, patch.object(
            release, "verify_public", side_effect=[RuntimeError("bad health"), None]
        ), self.assertRaisesRegex(
            RuntimeError, "previous image restored"
        ):
            release.deploy_release(session, "truckmate", IMAGE, REGION)
        self.assertEqual(
            [call.args[-1] for call in command.call_args_list], ["deploy", "rollback"]
        )

    def test_failed_rollback_is_reported_as_failure(self):
        session, ec2, ssm = session_for()
        with patch.object(
            release,
            "run_command",
            side_effect=["deploy-command", RuntimeError("rollback failed")],
        ), patch.object(
            release, "verify_public", side_effect=RuntimeError("bad health")
        ), self.assertRaisesRegex(
            RuntimeError, "rollback verification failed"
        ):
            release.deploy_release(session, "truckmate", IMAGE, REGION)

    def test_success_is_recorded_after_public_verification(self):
        session, ec2, ssm = session_for()
        with patch.object(release, "run_command", return_value="command"), patch.object(
            release, "verify_public"
        ) as health:
            result = release.deploy_release(session, "truckmate", IMAGE, REGION)
        health.assert_called_once()
        self.assertEqual(result["status"], "deployed")
        self.assertEqual(result["image"], IMAGE)

    @patch.object(
        release.boto3, "Session", side_effect=AssertionError("AWS call in preview")
    )
    def test_preview_does_not_call_aws(self, session):
        with patch(
            "sys.argv", ["release.py", "--image", IMAGE, "--region", REGION]
        ), contextlib.redirect_stdout(io.StringIO()):
            release.main()
        session.assert_not_called()

    def test_tags_are_rejected_before_deployment(self):
        session, ec2, ssm = session_for()
        with self.assertRaisesRegex(ValueError, "immutable"):
            release.deploy_release(
                session, "truckmate", IMAGE.split("@")[0] + ":latest", REGION
            )
        session.client.assert_not_called()


if __name__ == "__main__":
    unittest.main()

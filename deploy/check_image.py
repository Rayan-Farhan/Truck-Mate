"""Check an image locally without production settings or upstream API calls."""

import argparse
import json
import re
import subprocess
import time
import urllib.request


def check_image(image):
    container = subprocess.check_output(
        [
            "docker",
            "run",
            "--rm",
            "-d",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "-e",
            "DJANGO_SECRET_KEY=ci-image-check-only",
            "-e",
            "DJANGO_ALLOWED_HOSTS=localhost,127.0.0.1",
            "-p",
            "127.0.0.1::8000",
            image,
        ],
        text=True,
    ).strip()
    try:
        port = (
            subprocess.check_output(
                ["docker", "port", container, "8000/tcp"],
                text=True,
            )
            .strip()
            .rsplit(":", 1)[1]
        )
        base = "http://127.0.0.1:" + port
        for attempt in range(30):
            try:
                with urllib.request.urlopen(
                    base + "/api/health", timeout=2
                ) as response:
                    if response.status == 200 and json.load(response) == {
                        "status": "ok"
                    }:
                        break
            except OSError:
                pass
            time.sleep(1)
        else:
            raise RuntimeError("Image health check failed")
        with urllib.request.urlopen(base + "/", timeout=5) as response:
            page = response.read().decode()
        if "<html" not in page.lower():
            raise RuntimeError("Image did not serve the frontend")
        assets = re.findall(r'(?:src|href)="(/assets/[^\"]+)"', page)
        if not assets:
            raise RuntimeError("Frontend asset references are missing")
        for asset in assets:
            with urllib.request.urlopen(base + asset, timeout=5) as response:
                if response.status != 200:
                    raise RuntimeError("Frontend asset check failed")
        details = json.loads(
            subprocess.check_output(["docker", "inspect", container], text=True)
        )[0]
        if details["Config"]["User"].split(":", 1)[0] in ["", "0", "root"]:
            raise RuntimeError("Application image must run as a non-root user")
        names = {value.split("=", 1)[0] for value in details["Config"]["Env"]}
        if names & {"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"}:
            raise RuntimeError("Application image embeds AWS credentials")
        print(
            "Image checks passed: health, frontend assets, non-root user and no AWS keys."
        )
    finally:
        subprocess.run(
            ["docker", "stop", container],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image")
    check_image(parser.parse_args().image)

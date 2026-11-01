"""Check a data.yaml before Ultralytics reads it.

When a split path is missing, Ultralytics treats `download` as a URL, a shell command or
Python source and runs it. A dataset directory is data, so only the URL form may pass.
"""

import re

import yaml

_ZIP_URL = re.compile(r"https?://\S+\.zip")


def problem(path: str) -> str | None:
    """Why this data.yaml must not be handed to Ultralytics, or None when it is fine."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
    except (OSError, UnicodeError, yaml.YAMLError) as e:
        # Ultralytics strips characters PyYAML refuses, so it may read what this cannot.
        return f"failed to parse data.yaml: {str(e)[:200]}"
    if not isinstance(data, dict):
        return None
    download = data.get("download")
    if download is None or (isinstance(download, str) and _ZIP_URL.fullmatch(download)):
        return None
    return "data.yaml 'download' may only be an http(s) .zip URL"

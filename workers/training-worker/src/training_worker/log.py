import datetime
import json
import sys


def log(level: str, message: str, **fields: object) -> None:
    record = {
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "level": level,
        "service": "training-worker",
        "message": message,
    }
    for k, v in fields.items():
        if v is not None:
            record[k] = v
    sys.stdout.write(json.dumps(record) + "\n")
    sys.stdout.flush()


def info(message: str, **fields: object) -> None:
    log("INFO", message, **fields)


def warn(message: str, **fields: object) -> None:
    log("WARN", message, **fields)


def error(message: str, **fields: object) -> None:
    log("ERROR", message, **fields)

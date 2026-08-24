#!/usr/bin/env python3
"""Push a scraper output folder to the Lead Portal.

This file does not belong to the portal at runtime — copy it into the scraper
project (it lives here so the endpoint and its only client stay in one repo and
cannot drift). Standard library only, so it runs in any virtualenv the scraper
already has.

    python push_leads.py ./output --source google
    python push_leads.py ./output/yelp_dentists.csv --batch yelp-dentists

Configuration, by environment variable or flag:

    LEAD_PORTAL_URL     https://leads.spiderhunts-coworkingspace.com
    LEAD_PORTAL_TOKEN   the INGEST_TOKEN from /etc/lead-portal/env

`--source` names the directory the run read: `yelp` (the default) or `google`.
It is a FALLBACK, not a label — the portal believes each row's own `source`
column first and its listing URL second, so a `google.com/maps/place/...` in a
row files that row as Google whatever this flag says. That is deliberate: a
folder that picked up one CSV from the other run would otherwise be relabelled
wholesale. The portal reports back what the rows actually resolved to.

Semantics worth knowing before wiring this into a cron job: the endpoint
MERGES. Businesses already in the portal are skipped untouched, so agents'
statuses, notes and booked callbacks survive every re-scrape. Running this
twice on the same folder inserts nothing the second time.

Exit codes: 0 pushed, 1 refused by the server or nothing to send, 2 misconfigured.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ENDPOINT = "/api/leads/ingest"
# What the portal will accept in X-Source. Anything else is a 400 there rather
# than a default, so it is refused here too — with a message that names the
# flag instead of quoting an HTTP status.
SOURCES = ("yelp", "google")
# The server rejects >32MB per push; stop before the wire so the failure names
# the actual problem instead of arriving as a 413.
MAX_BYTES = 32 * 1024 * 1024


def csv_files(target: Path) -> list[Path]:
    """Every CSV under `target`, or `target` itself if it is one file."""
    if target.is_file():
        return [target]
    if not target.is_dir():
        raise SystemExit(f"error: no such file or folder: {target}")
    # Sorted so a run is reproducible and the portal's insertion order (which
    # is the order agents work the list in) matches the folder.
    return sorted(p for p in target.rglob("*.csv") if p.is_file())


def encode_multipart(files: list[Path]) -> tuple[bytes, str]:
    """Build a multipart/form-data body with one `file` part per CSV."""
    boundary = f"----leadportal{uuid.uuid4().hex}"
    parts: list[bytes] = []

    for path in files:
        content_type = mimetypes.guess_type(path.name)[0] or "text/csv"
        parts.append(
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="{path.name}"\r\n'
            f"Content-Type: {content_type}\r\n\r\n".encode()
        )
        parts.append(path.read_bytes())
        parts.append(b"\r\n")

    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def push(
    base_url: str,
    token: str,
    files: list[Path],
    batch: str | None,
    source: str | None,
) -> dict:
    body, content_type = encode_multipart(files)
    if len(body) > MAX_BYTES:
        raise SystemExit(
            f"error: {len(body) / 1024 / 1024:.1f}MB exceeds the {MAX_BYTES // 1024 // 1024}MB "
            "per-push limit — split the folder across two runs."
        )

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": content_type,
    }
    if batch:
        headers["X-Batch"] = batch
    if source:
        headers["X-Source"] = source

    request = urllib.request.Request(
        base_url.rstrip("/") + ENDPOINT, data=body, headers=headers, method="POST"
    )

    try:
        # Generous: the portal parses and writes the whole push inside the
        # request, and nginx in front of it allows 120s.
        with urllib.request.urlopen(request, timeout=180) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        try:
            message = json.loads(detail).get("message", detail)
        except json.JSONDecodeError:
            message = detail
        raise SystemExit(f"error: portal returned {error.code}: {message}")
    except urllib.error.URLError as error:
        raise SystemExit(f"error: could not reach {base_url}: {error.reason}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", type=Path, help="output folder, or a single CSV")
    parser.add_argument(
        "--url",
        default=os.environ.get("LEAD_PORTAL_URL"),
        help="portal base URL (default: $LEAD_PORTAL_URL)",
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("LEAD_PORTAL_TOKEN"),
        help="ingest token (default: $LEAD_PORTAL_TOKEN)",
    )
    parser.add_argument("--batch", help="name for this run, stamped on every row")
    parser.add_argument(
        "--source",
        choices=SOURCES,
        help="which directory this run read; used only for rows that do not say "
        "(default: yelp, the portal's own default)",
    )
    args = parser.parse_args()

    if not args.url or not args.token:
        print(
            "error: set LEAD_PORTAL_URL and LEAD_PORTAL_TOKEN (or pass --url / --token)",
            file=sys.stderr,
        )
        return 2

    files = csv_files(args.target)
    if not files:
        print(f"nothing to push: no .csv files under {args.target}", file=sys.stderr)
        return 1

    print(f"pushing {len(files)} file(s) to {args.url}{ENDPOINT}")
    result = push(args.url, args.token, files, args.batch, args.source)

    print(
        f"inserted {result['inserted']} new lead(s), "
        f"skipped {result['skippedExisting']} already in the portal "
        f"(batch {result['sourceBatch']})"
    )
    # What the rows actually resolved to. Printed whenever it is not simply the
    # source that was declared — that disagreement is the visible symptom of a
    # CSV from the other scraper sitting in this output folder.
    by_source = result.get("bySource") or {}
    landed = {name: count for name, count in by_source.items() if count}
    declared = result.get("declaredSource")
    if len(landed) > 1 or (landed and declared and declared not in landed):
        summary = ", ".join(f"{count} {name}" for name, count in landed.items())
        print(f"  source breakdown: {summary} (declared {declared})", file=sys.stderr)

    for report in result.get("files", []):
        for warning in report.get("warnings", []):
            print(f"  {report['filename']}: {warning}", file=sys.stderr)
    if result.get("rejectedFiles"):
        print(f"  unusable file(s): {', '.join(result['rejectedFiles'])}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())

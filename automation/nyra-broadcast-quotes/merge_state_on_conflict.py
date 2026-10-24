"""Semantic merge for the two state files, used by the workflow's "Commit
updated state" step ONLY when a plain `git push` is rejected (origin/main
moved since checkout).

A plain `git pull --rebase` used to handle that — confirmed real 2026-10-24
it fails outright when BOTH sides append new entries to the end of the same
JSON array (this run's own new broadcasts, and a same-minute push doing the
same): that's a textual conflict git's rebase can't auto-resolve, even
though the actual merge rule is trivial once you're not asking git to guess
it from a line diff. This merges by id/key instead, so both sides' new
entries always survive regardless of order.

Reads the current (local, post-run) state files plus whatever's on
origin/main right now (via `git show`, after the caller's own `git fetch`),
unions them, and overwrites the local files in place. The caller is
responsible for `git reset --soft origin/main` + re-add + re-commit after
this runs.
"""
import json
import subprocess


def git_show(path):
    result = subprocess.run(["git", "show", f"origin/main:{path}"], capture_output=True, text=True)
    return result.stdout if result.returncode == 0 else None


def merge_processed_ids(path):
    with open(path) as f:
        local = json.load(f)
    remote_raw = git_show(path)
    remote = json.loads(remote_raw) if remote_raw else {"ids": []}
    merged = list(dict.fromkeys(remote.get("ids", []) + local.get("ids", [])))
    with open(path, "w") as f:
        json.dump({"ids": merged}, f, indent=2)


def merge_dropped_quotes(path):
    with open(path) as f:
        local = json.load(f)
    remote_raw = git_show(path)
    remote = json.loads(remote_raw) if remote_raw else []
    by_key = {d["key"]: d for d in remote}
    by_key.update({d["key"]: d for d in local})
    with open(path, "w") as f:
        json.dump(list(by_key.values()), f, indent=2)


if __name__ == "__main__":
    merge_processed_ids("state/processed_video_ids.json")
    merge_dropped_quotes("state/dropped_quotes.json")
    print("Merged state files by id/key.")

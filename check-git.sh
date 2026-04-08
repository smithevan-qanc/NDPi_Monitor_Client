#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"
git fetch origin main

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" != "$REMOTE" ]; then
    git reset --hard origin/main
fi
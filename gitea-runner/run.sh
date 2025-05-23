#!/bin/sh
# Read options from /data/options.json and export as environment variables
export GITEA_INSTANCE_URL=$(jq -r '.instance' /data/options.json)
export GITEA_RUNNER_REGISTRATION_TOKEN=$(jq -r '.token' /data/options.json)
export GITEA_RUNNER_LABELS=$(jq -r '.labels' /data/options.json)
export GITEA_RUNNER_NAME=$(jq -r '.name' /data/options.json)

# Start your application
exec /sbin/tini -- /opt/act/run.sh
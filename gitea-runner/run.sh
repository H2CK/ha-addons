#!/usr/bin/with-contenv bashio
# Read options from /data/options.json and export as environment variables

CONFIG_PATH=/data/options.json

export GITEA_INSTANCE_URL="$(bashio::config 'instance')"
export GITEA_RUNNER_REGISTRATION_TOKEN="$(bashio::config 'token')"
export GITEA_RUNNER_LABELS="$(bashio::config 'labels')"
export GITEA_RUNNER_NAME="$(bashio::config 'name')"

# Start your application
exec /sbin/tini -- /opt/act/run.sh
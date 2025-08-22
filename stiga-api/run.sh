#!/usr/bin/with-contenv bashio
MQTT_HOST=$(bashio::services mqtt "host")
MQTT_USER=$(bashio::services mqtt "username")
MQTT_PASSWORD=$(bashio::services mqtt "password")

STIGA_USERNAME="$(bashio::config 'stiga_username')"
STIGA_PASSWORD="$(bashio::config 'stiga_password')"

cd /var/stiga-api/homeassistant
node ha-mqtt-bridge.js "$STIGA_USERNAME" "$STIGA_PASSWORD" "$MQTT_HOST" "$MQTT_USER" "$MQTT_PASSWORD"

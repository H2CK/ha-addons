#!/usr/bin/with-contenv bashio
echo "Starting STIGA-API  HA bridge..."
MQTT_HOST=$(bashio::services mqtt "host")
MQTT_PORT=$(bashio::services mqtt "port")
MQTT_PROTOCOL="mqtt://"
MQTT_DOMAIN=".local.hass.io"
echo "Using MQTT URL: $MQTT_PROTOCOL$MQTT_HOST$MQTT_DOMAIN:$MQTT_PORT"
MQTT_USER=$(bashio::services mqtt "username")
MQTT_PASSWORD=$(bashio::services mqtt "password")

STIGA_USERNAME="$(bashio::config 'stiga_username')"
STIGA_PASSWORD="$(bashio::config 'stiga_password')"

cd /var/stiga-api/homeassistant
node ha-mqtt-bridge.js "$STIGA_USERNAME" "$STIGA_PASSWORD" "$MQTT_PROTOCOL$MQTT_HOST$MQTT_DOMAIN:$MQTT_PORT" "$MQTT_USER" "$MQTT_PASSWORD"

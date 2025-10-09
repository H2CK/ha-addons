#!/usr/bin/with-contenv bashio

set +x

MQTT_HOST=$(bashio::services mqtt "host")
MQTT_PORT=$(bashio::services mqtt "port")
MQTT_PROTOCOL="mqtt://"
MQTT_DOMAIN=".local.hass.io"
echo "Using MQTT URL: $MQTT_PROTOCOL$MQTT_HOST$MQTT_DOMAIN:$MQTT_PORT"
MQTT_USER=$(bashio::services mqtt "username")
MQTT_PASSWORD=$(bashio::services mqtt "password")

SAX_HOST=$(bashio::config 'sax_host')
SAX_PORT=$(bashio::config 'sax_port')
ADL_HOST=$(bashio::config 'adl_host')
ADL_PORT=$(bashio::config 'adl_port')
CONFIG_LOGLEVEL=$(bashio::config 'loglevel')
TIMEOUT=$(bashio::config 'timeout')
MQTT_UPDATE_FACTOR=$(bashio::config 'mqtt_update_factor')

cd /srv
if [ -f "./venv/bin/activate" ] ; then
    source ./venv/bin/activate
fi

if bashio::config.true 'simulate_write'; then
  python pwrmgr.py "-sim" "--timeout=$TIMEOUT" "--mqtt-update-factor=$MQTT_UPDATE_FACTOR" "--host-sax=$SAX_HOST" "--port-sax=$SAX_PORT" "--host-adl=$ADL_HOST" "--port-adl=$ADL_PORT" "--host-mqtt=$MQTT_HOST" "--port-mqtt=$MQTT_PORT" "--user-mqtt=$MQTT_USER" "--pw-mqtt=$MQTT_PASSWORD" "--log=$CONFIG_LOGLEVEL"
else
  python pwrmgr.py "--timeout=$TIMEOUT" "--mqtt-update-factor=$MQTT_UPDATE_FACTOR" "--host-sax=$SAX_HOST" "--port-sax=$SAX_PORT" "--host-adl=$ADL_HOST" "--port-adl=$ADL_PORT" "--host-mqtt=$MQTT_HOST" "--port-mqtt=$MQTT_PORT" "--user-mqtt=$MQTT_USER" "--pw-mqtt=$MQTT_PASSWORD" "--log=$CONFIG_LOGLEVEL"
fi

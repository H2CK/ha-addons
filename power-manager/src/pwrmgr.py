#!/usr/bin/env python3
import argparse
import os
import sys
import time
import signal
import json
import logging
import schedule
import requests

from pyModbusTCP.client import ModbusClient

import asyncio
from aiomqtt import Client, MqttError

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)

SW_VERSION = "1.0.0"

DISCOVERY_PREFIX = "homeassistant"

UUID = "57f8797a-1137-4963-8109-d552f99cffc1"
NAME = "Power Manager"
DEVICE = {
            "identifiers": [UUID],
            "manufacturer": "jagel.net",
            "model_id": "PM 1.0",
            "name": NAME,
            "serial_number": "1",
            "sw_version": SW_VERSION
        }

UNIT_ID_SAX = 64                   # Geräteadresse/Slave ID
UNIT_ID_ADL = 158                   # Geräteadresse/Slave ID

REG_SAX_START = 45
REG_ADL_START = 0x61

mqtt_client = None
connected_event = asyncio.Event()

client_sax = None
client_adl = None
sax_value = None
adl_value = None
pv_value = [0,0,0,0]
sax_data_event = asyncio.Event() # Set when first data from SAX Battery was received
adl_data_event = asyncio.Event() # Set when first data from ADL was received
cargs = None
grid_loading = False
emergency_reserve = 9
limit_charging = 3500
limit_discharging = 3500
prio_charging = 3500

base_topic = f"{DISCOVERY_PREFIX}/device/{UUID}"
base_availability_topic = f"{base_topic}/availability"
base_sensor_topic = f"{DISCOVERY_PREFIX}/sensor/{UUID}"
base_number_topic = f"{DISCOVERY_PREFIX}/number/{UUID}"
base_switch_topic = f"{DISCOVERY_PREFIX}/switch/{UUID}"
base_button_topic = f"{DISCOVERY_PREFIX}/button/{UUID}"

pm_base_topic = f"power-mgr/{UUID}"

counter = 0
mqtt_lock = False

def parse_arguments():
    parser = argparse.ArgumentParser(description="Power Manager")
    parser.add_argument(
        "-d",
        action="store_true",  # This means the flag is optional and sets to True if present
        help="Run the process as a daemon (in the background)",
        default=False,  # Default is False if the flag is not provided
    )
    parser.add_argument(
        "-sim",
        action="store_true",  # This means the flag is optional and sets to True if present
        help="Simulate all Modbus write activities",
        default=False,  # Default is False if the flag is not provided
    )
    parser.add_argument("--host-sax", type=str, required=True, help="Host address of SAX Battery")
    parser.add_argument("--port-sax", type=int, required=True, help="Port of SAX Battery")
    parser.add_argument("--host-adl", type=str, required=True, help="Host address of ADL400 SmartMeter")
    parser.add_argument("--port-adl", type=int, required=True, help="Port of ADL400 SmartMeter")
    parser.add_argument("--host-mqtt", type=str, required=True, help="Host adresse of MQTT Broker")
    parser.add_argument("--port-mqtt", type=int, required=True, help="Port of MQTT Broker")
    parser.add_argument("--user-mqtt", type=str, required=True, help="Username for MQTT Broker")
    parser.add_argument("--pw-mqtt", type=str, required=True, help="Password for MQTT Broker")
    parser.add_argument("--url-pv", type=str, required=True, help="URL for request to PV (only the host part, e.g. http://192.168.1.139)")
    parser.add_argument("--user-pv", type=str, required=True, help="Username for REST request to PV")
    parser.add_argument("--pw-pv", type=str, required=True, help="Password for REST request to PV")
    parser.add_argument("--log", type=str, required=False, default="INFO", help="Define logging level (INFO, ERROR or DEBUG) (default: INFO)")
    parser.add_argument("--timeout", type=int, required=False, default=1, help="Timeout after a cycle before a new cycle starts")
    parser.add_argument("--mqtt-update-factor", type=int, required=False, default=1, help="Factor how often an mqtt update is performed")
    return parser.parse_args()

def daemonize():
    if os.fork() > 0:
        sys.exit(0)  # Terminate parent process

    os.setsid()  # Start new session
    if os.fork() > 0:
        sys.exit(0)  # Terminate first child process

    sys.stdout.flush()
    sys.stderr.flush()
    with open('/dev/null', 'r') as dev_null:
        os.dup2(dev_null.fileno(), sys.stdin.fileno())
    with open('/dev/null', 'a+') as dev_null:
        os.dup2(dev_null.fileno(), sys.stdout.fileno())
        os.dup2(dev_null.fileno(), sys.stderr.fileno())

def signal_handler(signum, frame):
    logging.info("Power Manager is terminated...")
    sys.exit(0)

def fetch_pv_data():
    global cargs, pv_value
    try:
        logging.debug(f"Sending REST request to {cargs.url_pv}/api/dxs.json?dxsEntries=33556736&dxsEntries=67109120&dxsEntries=16780032&dxsEntries=251658754")
        starttime = time.time()
        response = requests.get(f"{cargs.url_pv}/api/dxs.json?dxsEntries=33556736&dxsEntries=67109120&dxsEntries=16780032&dxsEntries=251658754", auth=(cargs.user_pv, cargs.pw_pv), timeout=10, verify=True)
        
        response.raise_for_status()
        data = response.json()
        totaltime = (time.time() - starttime) * 1000
        logging.debug(f"Received REST response: {response.text}")
        entries = data.get("dxsEntries", [])
        if len(entries) == 4:
            pv_value[0] = entries[0].get("value")
            pv_value[1] = entries[1].get("value")
            pv_value[2] = entries[2].get("value")
            pv_value[3] = entries[3].get("value")
            logging.info(f"PV data fetching terminated in {totaltime:.3f}ms: DC Power {pv_value[0]}W / AC Power {pv_value[1]}W / State {pv_value[2]}")
        else:
            logging.error("REST request failed: Missing entries")
            pv_value[0] = 0
            pv_value[1] = 0
            pv_value[2] = 0
            pv_value[3] = 0

    except requests.exceptions.RequestException as e:
        logging.error(f"REST request failed: {e}")
        pv_value[0] = 0
        pv_value[1] = 0
        pv_value[2] = 0
        pv_value[3] = 0

    return None


async def mqtt_task(args):
    global mqtt_client, client_sax, sax_value, adl_value, grid_loading, emergency_reserve, limit_charging, limit_discharging, prio_charging
    try:
        async with Client(
            hostname=args.host_mqtt,
            port=args.port_mqtt,
            username=args.user_mqtt,
            password=args.pw_mqtt
        ) as client:

            mqtt_client = client
            connected_event.set()
            logging.info("✅ Connected to MQTT Broker.")

            for topic in [
                    f"{pm_base_topic}/battery/power-cmd", 
                    f"{pm_base_topic}/battery/grid-loading", 
                    f"{pm_base_topic}/battery/emergency-power-reserve", 
                    f"{pm_base_topic}/battery/charging-limit", 
                    f"{pm_base_topic}/battery/discharging-limit", 
                    f"{pm_base_topic}/battery/prio-charging"
                        ]:
                await client.subscribe(topic)
                logging.info(f"✅ Subscribed: {topic}")
        
            async for message in client.messages:
                topic = message.topic
                payload = message.payload.decode()
                logging.info(f"📩 MQTT Message received {topic}: {payload}")
            
                if topic.matches(f"{pm_base_topic}/battery/power-cmd"):
                    await sax_data_event.wait() # Wait for battery data
                    if payload == "OFF" and sax_value[0] != 1: # Turn off
                        logging.info("Turning battery off.")
                        write_modbus(client_sax, 45, [1])
                    elif payload == "ON" and sax_value[0] == 1: # Turn on
                        logging.info("Turning battery on.")
                        write_modbus(client_sax, 45, [2])
                    else: 
                        logging.info("No change for battery power on/off necessary.")

                elif topic.matches(f"{pm_base_topic}/battery/grid-loading"):
                    if payload == "OFF":
                        grid_loading = False
                    else:
                        grid_loading = True

                    logging.info(f"Turning grid loading {payload}.")

                elif topic.matches(f"{pm_base_topic}/battery/emergency-power-reserve"):
                    emergency_reserve = int(payload)
                    logging.info(f"Setting emergency reserve to {payload}%.")

                elif topic.matches(f"{pm_base_topic}/battery/charging-limit"):
                    limit_charging = int(payload)
                    logging.info(f"Setting charging limit to {payload}W.")
                    write_modbus(client_sax, 44, [limit_charging])

                elif topic.matches(f"{pm_base_topic}/battery/discharging-limit"):
                    limit_discharging = int(payload)
                    logging.info(f"Setting discharging limit to {payload}W.")
                    write_modbus(client_sax, 43, [limit_discharging])
                
                elif topic.matches(f"{pm_base_topic}/battery/prio-charging"):
                    prio_charging = int(payload)
                    logging.info(f"Setting prio charging to {payload}W.")

    except MqttError as error:
        logging.error(f"❌ MQTT error: {error}")

async def send_mqtt_message(topic, payload, retain=False, overwrite_lock=False):
    global mqtt_client, mqtt_lock
    if mqtt_lock and not overwrite_lock:
        logging.debug("Skipping MQTT update.")
        return None
    if mqtt_client is not None:
        logging.debug(f"Publishing MQTT: {topic} => {payload}")
        await mqtt_client.publish(topic, payload, retain=retain)
    else:
        logging.error("❌ Unable to send MQTT message. Client not yet connected.")

# HA Discovery
async def send_ha_discovery():
    discovery_payload = {
        "name": NAME,
        "unique_id": UUID,
        "command_topic": f"{base_topic}/command",
        "availability_topic": f"{base_availability_topic}",
        "json_attributes_topic": f"{base_topic}/attributes",
        "device": DEVICE,
        "o": {
            "name": "power-manager",
            "sw": SW_VERSION,
            "url": "https://github.com/"
        }
    }
    discovery_battery_state_sensor = {
        "name": "Battery Operation Mode",
        "unique_id": f"{UUID}_pm_battery_state",
        "icon": "mdi:state-machine",
        "state_topic": f"{pm_base_topic}/battery/state",
        "value_template": "{{ value_json }}",
        "device": DEVICE
    }
    discovery_battery_soc_sensor = {
        "name": "Battery SoC",
        "unique_id": f"{UUID}_pm_battery_soc",
        "state_topic": f"{pm_base_topic}/battery/soc",
        "value_template": "{{ value_json }}",
        "unit_of_measurement": "%",
        "device_class": "battery",
        "device": DEVICE
    }
    discovery_battery_power_sensor = {
        "name": "Battery Power",
        "unique_id": f"{UUID}_pm_battery_power",
        "state_topic": f"{pm_base_topic}/battery/power",
        "value_template": "{{ value_json }}",
        "unit_of_measurement": "W",
        "device_class": "power",
        "state_class": "measurement",
        "device": DEVICE
    }
    discovery_battery_smpower_sensor = {
        "name": "Battery SmartMeter Power",
        "unique_id": f"{UUID}_pm_battery_smpower",
        "state_topic": f"{pm_base_topic}/battery/smpower",
        "value_template": "{{ value_json }}",
        "unit_of_measurement": "W",
        "device_class": "power",
        "state_class": "measurement",
        "device": DEVICE
    }
    discovery_battery_target_power_sensor = {
        "name": "Battery Target Power",
        "unique_id": f"{UUID}_pm_battery_target_power",
        "state_topic": f"{pm_base_topic}/battery/target_power",
        "value_template": "{{ value_json }}",
        "unit_of_measurement": "W",
        "device_class": "power",
        "state_class": "measurement",
        "device": DEVICE
    }
    discovery_smartmeter_voltage_a_sensor = {
        "name": "SmartMeter Voltage Phase A",
        "unique_id": f"{UUID}_pm_smartmeter_voltage_a",
        "state_topic": f"{pm_base_topic}/smartmeter/voltage/A",
        "value_template": "{{ value_json }}",
        "unit_of_measurement": "V",
        "device_class": "voltage",
        "state_class": "measurement",
        "device": DEVICE
    }
    discovery_smartmeter_voltage_b_sensor = {
        "name": "SmartMeter Voltage Phase B",
        "unique_id": f"{UUID}_pm_smartmeter_voltage_b",
        "state_topic": f"{pm_base_topic}/smartmeter/voltage/B",
        "value_template": "{{ value_json }}",
        "unit_of_measurement": "V",
        "device_class": "voltage",
        "state_class": "measurement",
        "device": DEVICE
    }
    discovery_smartmeter_voltage_c_sensor = {
        "name": "SmartMeter Voltage Phase C",
        "unique_id": f"{UUID}_pm_smartmeter_voltage_c",
        "state_topic": f"{pm_base_topic}/smartmeter/voltage/C",
        "value_template": "{{ value_json }}",
        "unit_of_measurement": "V",
        "device_class": "voltage",
        "state_class": "measurement",
        "device": DEVICE
    }
    discovery_smartmeter_current_a_sensor = {
        "name": "SmartMeter Current Phase A",
        "unique_id": f"{UUID}_pm_smartmeter_current_a",
        "state_topic": f"{pm_base_topic}/smartmeter/current/A",
        "value_template": "{{ value_json }}",
        "unit_of_measurement": "A",
        "device_class": "current",
        "state_class": "measurement",
        "device": DEVICE
    }
    discovery_smartmeter_current_b_sensor = {
        "name": "SmartMeter Current Phase B",
        "unique_id": f"{UUID}_pm_smartmeter_current_b",
        "state_topic": f"{pm_base_topic}/smartmeter/current/B",
        "value_template": "{{ value_json }}",
        "unit_of_measurement": "A",
        "device_class": "current",
        "state_class": "measurement",
        "device": DEVICE
    }
    discovery_smartmeter_current_c_sensor = {
        "name": "SmartMeter Current Phase C",
        "unique_id": f"{UUID}_pm_smartmeter_current_c",
        "state_topic": f"{pm_base_topic}/smartmeter/current/C",
        "value_template": "{{ value_json }}",
        "unit_of_measurement": "A",
        "device_class": "current",
        "state_class": "measurement",
        "device": DEVICE
    }
    discovery_smartmeter_actpower_a_sensor = {
        "name": "SmartMeter Active Power Phase A",
        "unique_id": f"{UUID}_pm_smartmeter_actpower_a",
        "state_topic": f"{pm_base_topic}/smartmeter/power/active/A",
        "value_template": "{{ value_json }}",
        "unit_of_measurement": "W",
        "device_class": "power",
        "state_class": "measurement",
        "device": DEVICE
    }
    discovery_smartmeter_actpower_b_sensor = {
        "name": "SmartMeter Active Power Phase B",
        "unique_id": f"{UUID}_pm_smartmeter_actpower_b",
        "state_topic": f"{pm_base_topic}/smartmeter/power/active/B",
        "value_template": "{{ value_json }}",
        "unit_of_measurement": "W",
        "device_class": "power",
        "state_class": "measurement",
        "device": DEVICE
    }
    discovery_smartmeter_actpower_c_sensor = {
        "name": "SmartMeter Active Power Phase C",
        "unique_id": f"{UUID}_pm_smartmeter_actpower_c",
        "state_topic": f"{pm_base_topic}/smartmeter/power/active/C",
        "value_template": "{{ value_json }}",
        "unit_of_measurement": "W",
        "device_class": "power",
        "state_class": "measurement",
        "device": DEVICE
    }
    discovery_smartmeter_actpower_total_sensor = {
        "name": "SmartMeter Active Power Total",
        "unique_id": f"{UUID}_pm_smartmeter_actpower_total",
        "state_topic": f"{pm_base_topic}/smartmeter/power/active/total",
        "value_template": "{{ value_json }}",
        "unit_of_measurement": "W",
        "device_class": "power",
        "state_class": "measurement",
        "device": DEVICE
    }
    discovery_smartmeter_powerfactor_a_sensor = {
        "name": "SmartMeter Power Factor Phase A",
        "unique_id": f"{UUID}_pm_smartmeter_power_factor_a",
        "state_topic": f"{pm_base_topic}/smartmeter/power-factor/A",
        "value_template": "{{ value_json }}",
        "state_class": "measurement",
        "device": DEVICE
    }
    discovery_smartmeter_powerfactor_b_sensor = {
        "name": "SmartMeter Power Factor Phase B",
        "unique_id": f"{UUID}_pm_smartmeter_power_factor_b",
        "state_topic": f"{pm_base_topic}/smartmeter/power-factor/B",
        "value_template": "{{ value_json }}",
        "state_class": "measurement",
        "device": DEVICE
    }
    discovery_smartmeter_powerfactor_c_sensor = {
        "name": "SmartMeter Power Factor Phase C",
        "unique_id": f"{UUID}_pm_smartmeter_power_factor_c",
        "state_topic": f"{pm_base_topic}/smartmeter/power-factor/C",
        "value_template": "{{ value_json }}",
        "state_class": "measurement",
        "device": DEVICE
    }
    discovery_smartmeter_powerfactor_total_sensor = {
        "name": "SmartMeter Power Factor Total",
        "unique_id": f"{UUID}_pm_smartmeter_power_factor_total",
        "state_topic": f"{pm_base_topic}/smartmeter/power-factor/total",
        "value_template": "{{ value_json }}",
        "state_class": "measurement",
        "device": DEVICE
    }
    discovery_smartmeter_frequency_sensor = {
        "name": "SmartMeter Frequency",
        "unique_id": f"{UUID}_pm_smartmeter_frequency",
        "state_topic": f"{pm_base_topic}/smartmeter/frequency",
        "value_template": "{{ value_json }}",
        "unit_of_measurement": "Hz",
        "device_class": "frequency",
        "state_class": "measurement",
        "device": DEVICE
    }
    discovery_pv_state_sensor = {
        "name": "PV Operation Mode",
        "unique_id": f"{UUID}_pm_pv_state",
        "icon": "mdi:state-machine",
        "state_topic": f"{pm_base_topic}/pv/state",
        "value_template": "{{ value_json }}",
        "device": DEVICE
    }
    discovery_pv_power_sensor = {
        "name": "PV Power",
        "unique_id": f"{UUID}_pm_pv_power",
        "state_topic": f"{pm_base_topic}/pv/power/total",
        "value_template": "{{ value_json }}",
        "unit_of_measurement": "W",
        "device_class": "power",
        "state_class": "measurement",
        "device": DEVICE
    }
    discovery_pv_dc_power_sensor = {
        "name": "PV DC Power",
        "unique_id": f"{UUID}_pm_pv_dc_power",
        "state_topic": f"{pm_base_topic}/pv/power/dc_in",
        "value_template": "{{ value_json }}",
        "unit_of_measurement": "W",
        "device_class": "power",
        "state_class": "measurement",
        "device": DEVICE
    }
    discovery_pv_day_yield_sensor = {
        "name": "PV Day Yield",
        "unique_id": f"{UUID}_pm_pv_day_yield",
        "state_topic": f"{pm_base_topic}/pv/day_yield",
        "value_template": "{{ (value_json | float) / 1000 | round(1) }}",
        "unit_of_measurement": "kWh",
        "device_class": "energy",
        "state_class": "total_increasing",
        "device": DEVICE
    }
    discovery_battery_power_on_button = {
        "name": "Battery Power On",
        "unique_id": f"{UUID}_pm_battery_power_on",
        "command_topic": f"{pm_base_topic}/battery/power-cmd",
        "payload_press": "ON",
        "icon": "mdi:power-on",
        "device": DEVICE
    }
    discovery_battery_power_off_button = {
        "name": "Battery Power Off",
        "unique_id": f"{UUID}_pm_battery_power_off",
        "command_topic": f"{pm_base_topic}/battery/power-cmd",
        "payload_press": "OFF",
        "icon": "mdi:power-off",
        "device": DEVICE
    }
    discovery_battery_grid_loading_switch = {
        "name": "Battery Grid Loading",
        "unique_id": f"{UUID}_pm_battery_grid_loading_switch",
        "command_topic": f"{pm_base_topic}/battery/grid-loading",
        "qos": 1,
        "retain": True,
        "device_class": "switch",
        "device": DEVICE
    }
    discovery_battery_emergency_reserve_number = {
        "name": "Emergency Power Reserve",
        "unique_id": f"{UUID}_pm_emergency_power_reserve_number",
        "command_topic": f"{pm_base_topic}/battery/emergency-power-reserve",
        "qos": 1,
        "retain": True,
        "unit_of_measurement": "%",
        "min": "0",
        "max": "90",
        "mode": "slider",
        "device": DEVICE
    }
    discovery_battery_limit_charging_number = {
        "name": "Charging limit",
        "unique_id": f"{UUID}_pm_charging_limit_number",
        "command_topic": f"{pm_base_topic}/battery/charging-limit",
        "qos": 1,
        "retain": True,
        "unit_of_measurement": "W",
        "min": 0,
        "max": 3500,
        "mode": "slider",
        "step": 50,
        "device_class": "power",
        "device": DEVICE
    }
    discovery_battery_limit_discharging_number = {
        "name": "Discharging limit",
        "unique_id": f"{UUID}_pm_discharging_limit_number",
        "command_topic": f"{pm_base_topic}/battery/discharging-limit",
        "qos": 1,
        "retain": True,
        "unit_of_measurement": "W",
        "min": 0,
        "max": 4600,
        "mode": "slider",
        "step": 50,
        "device_class": "power",
        "device": DEVICE
    }
    discovery_battery_prio_charging_number = {
        "name": "Prioritized charging power",
        "unique_id": f"{UUID}_pm_prio_charging_number",
        "command_topic": f"{pm_base_topic}/battery/prio-charging",
        "qos": 1,
        "retain": True,
        "unit_of_measurement": "W",
        "min": 0,
        "max": 3500,
        "mode": "slider",
        "step": 50,
        "device_class": "power",
        "device": DEVICE
    }
    await send_mqtt_message(topic=f"{base_topic}/config", payload=json.dumps(discovery_payload), retain=True)
    await send_mqtt_message(topic=f"{base_sensor_topic}/battery_state/config", payload=json.dumps(discovery_battery_state_sensor), retain=True)
    await send_mqtt_message(topic=f"{base_sensor_topic}/battery_soc/config", payload=json.dumps(discovery_battery_soc_sensor), retain=True)
    await send_mqtt_message(topic=f"{base_sensor_topic}/battery_power/config", payload=json.dumps(discovery_battery_power_sensor), retain=True)
    await send_mqtt_message(topic=f"{base_sensor_topic}/battery_smpower/config", payload=json.dumps(discovery_battery_smpower_sensor), retain=True)
    await send_mqtt_message(topic=f"{base_sensor_topic}/battery_target_power/config", payload=json.dumps(discovery_battery_target_power_sensor), retain=True)
    await send_mqtt_message(topic=f"{base_sensor_topic}/smartmeter_voltage_a/config", payload=json.dumps(discovery_smartmeter_voltage_a_sensor), retain=True)
    await send_mqtt_message(topic=f"{base_sensor_topic}/smartmeter_voltage_b/config", payload=json.dumps(discovery_smartmeter_voltage_b_sensor), retain=True)
    await send_mqtt_message(topic=f"{base_sensor_topic}/smartmeter_voltage_c/config", payload=json.dumps(discovery_smartmeter_voltage_c_sensor), retain=True)
    await send_mqtt_message(topic=f"{base_sensor_topic}/smartmeter_current_a/config", payload=json.dumps(discovery_smartmeter_current_a_sensor), retain=True)
    await send_mqtt_message(topic=f"{base_sensor_topic}/smartmeter_current_b/config", payload=json.dumps(discovery_smartmeter_current_b_sensor), retain=True)
    await send_mqtt_message(topic=f"{base_sensor_topic}/smartmeter_current_c/config", payload=json.dumps(discovery_smartmeter_current_c_sensor), retain=True)
    await send_mqtt_message(topic=f"{base_sensor_topic}/smartmeter_actpower_a/config", payload=json.dumps(discovery_smartmeter_actpower_a_sensor), retain=True)
    await send_mqtt_message(topic=f"{base_sensor_topic}/smartmeter_actpower_b/config", payload=json.dumps(discovery_smartmeter_actpower_b_sensor), retain=True)
    await send_mqtt_message(topic=f"{base_sensor_topic}/smartmeter_actpower_c/config", payload=json.dumps(discovery_smartmeter_actpower_c_sensor), retain=True)
    await send_mqtt_message(topic=f"{base_sensor_topic}/smartmeter_actpower_total/config", payload=json.dumps(discovery_smartmeter_actpower_total_sensor), retain=True)
    await send_mqtt_message(topic=f"{base_sensor_topic}/smartmeter_power_factor_a/config", payload=json.dumps(discovery_smartmeter_powerfactor_a_sensor), retain=True)
    await send_mqtt_message(topic=f"{base_sensor_topic}/smartmeter_power_factor_b/config", payload=json.dumps(discovery_smartmeter_powerfactor_b_sensor), retain=True)
    await send_mqtt_message(topic=f"{base_sensor_topic}/smartmeter_power_factor_c/config", payload=json.dumps(discovery_smartmeter_powerfactor_c_sensor), retain=True)
    await send_mqtt_message(topic=f"{base_sensor_topic}/smartmeter_power_factor_total/config", payload=json.dumps(discovery_smartmeter_powerfactor_total_sensor), retain=True)
    await send_mqtt_message(topic=f"{base_sensor_topic}/smartmeter_frequency/config", payload=json.dumps(discovery_smartmeter_frequency_sensor), retain=True)
    await send_mqtt_message(topic=f"{base_sensor_topic}/pv_state/config", payload=json.dumps(discovery_pv_state_sensor), retain=True)
    await send_mqtt_message(topic=f"{base_sensor_topic}/pv_power/config", payload=json.dumps(discovery_pv_power_sensor), retain=True)
    await send_mqtt_message(topic=f"{base_sensor_topic}/pv_dc_power/config", payload=json.dumps(discovery_pv_dc_power_sensor), retain=True)
    await send_mqtt_message(topic=f"{base_sensor_topic}/pv_day_yield/config", payload=json.dumps(discovery_pv_day_yield_sensor), retain=True)
    await send_mqtt_message(topic=f"{base_button_topic}/battery_power_on/config", payload=json.dumps(discovery_battery_power_on_button), retain=True)
    await send_mqtt_message(topic=f"{base_button_topic}/battery_power_off/config", payload=json.dumps(discovery_battery_power_off_button), retain=True)
    await send_mqtt_message(topic=f"{base_switch_topic}/battery_grid/config", payload=json.dumps(discovery_battery_grid_loading_switch), retain=True)
    await send_mqtt_message(topic=f"{base_number_topic}/emergency_power_reserve/config", payload=json.dumps(discovery_battery_emergency_reserve_number), retain=True)
    await send_mqtt_message(topic=f"{base_number_topic}/limit_charging/config", payload=json.dumps(discovery_battery_limit_charging_number), retain=True)
    await send_mqtt_message(topic=f"{base_number_topic}/limit_discharging/config", payload=json.dumps(discovery_battery_limit_discharging_number), retain=True)
    await send_mqtt_message(topic=f"{base_number_topic}/prio_charging/config", payload=json.dumps(discovery_battery_prio_charging_number), retain=True)

def unsigned_to_signed(unsigned_value, bits=16):
    max_unsigned = 2 ** bits
    max_signed = 2 ** (bits - 1)
    return unsigned_value if unsigned_value < max_signed else unsigned_value - max_unsigned

def fetch_modbus(client, start, length):
    for _ in range(5):
        result = client.read_holding_registers(start, length)
        if result is not None:
            return result
    
    return None

def write_modbus(client, register, values):
    global cargs
    if cargs.sim:
        logging.info("Writing modbus skipped.")
        return None
    starttime = time.time()
    result = client.write_multiple_registers(register, values)
    endtime = time.time()
    totaltime = endtime - starttime
    logging.info(f"Writing modbus in {totaltime:.3f}ms: Register - {register} / {values}")
    #SAX liefert immer falsche Transaction ID zurück
    #if result:
    #    print("Erfolgreich geschrieben")
    #else:
    #    print("Schreiben fehlgeschlagen.")
    return result

def update_limits():
    global client_sax
    logging.info("Updating limits ...")
    write_modbus(client_sax, 43, [limit_discharging])
    write_modbus(client_sax, 44, [limit_charging])

async def main(args):
    global client_sax, client_adl, sax_value, adl_value, grid_loading, emergency_reserve, limit_charging, limit_discharging, prio_charging, cargs, counter, mqtt_lock
    logging.info("Starting Power Manager ...")
    signal.signal(signal.SIGTERM, signal_handler)  # Beenden bei SIGTERM

    cargs = args

    try:
        client_sax = ModbusClient(host=args.host_sax, port=args.port_sax, unit_id=UNIT_ID_SAX)
        client_adl = ModbusClient(host=args.host_adl, port=args.port_adl, unit_id=UNIT_ID_ADL)
        if client_sax.open():
            logging.info("✅ Connected to SAX Battery.")
        else:
            logging.error("❌ Connecting to SAX Battery failed.")

        if client_adl.open():
            logging.info("✅ Connected to ADL400.")
        else:
            logging.error("❌ Connecting to ADL400 failed.")

        task = asyncio.create_task(mqtt_task(args))
        await connected_event.wait() # Wait until mqtt is connected

        await send_ha_discovery()

        schedule.every(3).minutes.do(update_limits)

        while True:
            counter = (counter + 1) % args.mqtt_update_factor
            if counter == 0:
                mqtt_lock = False
            else:
                mqtt_lock = True

            await send_mqtt_message(topic=f"{base_availability_topic}", payload="online", retain=False)

            starttime_a = time.time()
            sax_value = fetch_modbus(client_sax, REG_SAX_START, 4)
            totaltime_sax = (time.time() - starttime_a) * 1000
            if sax_value is None:
                logging.error("No response could be retrieved by SAX Battery. Retrying full cycle.")
                continue
            sax_power = sax_value[2] - 16384
            sax_smpower = sax_value[3] - 16384
            sax_data_event.set()
            logging.debug(f"SAX Battery response in {totaltime_sax:.3f}ms: Mode {sax_value[0]} / SoC {sax_value[1]}% / Power {sax_power}W / SmartMeter Power {sax_smpower}W")

            starttime = time.time()
            adl_value = fetch_modbus(client_adl, REG_ADL_START, 23)
            totaltime_adl = (time.time() - starttime) * 1000
            if adl_value is None:
                logging.error("No response could be retrieved by SAX Battery. Retrying full cycle.")
                continue
            adl_pf = unsigned_to_signed(adl_value[21], 16) * 0.001
            adl_power = unsigned_to_signed(adl_value[9], 16)
            adl_data_event.set()
            logging.debug(f"ADL SmartMeter response in {totaltime_adl:.3f}ms: Total Power {adl_power}W / Power Factor {adl_pf:.3f}")

            #Calculate target values
            sax_target_value = sax_power + adl_power
            if sax_target_value > limit_discharging:
                sax_target_value = limit_discharging
            if sax_target_value < limit_charging * (-1):
                sax_target_value = limit_charging * (-1)
            if grid_loading:
                sax_target_value = prio_charging * (-1)
            if sax_target_value < 0 and sax_value[1] >= 100:
                sax_target_value = 0
            if sax_target_value > 0 and sax_value[1] <= emergency_reserve:
                sax_target_value = 0
            if adl_pf < 0:
                adl_pf = adl_pf * (-1)
            write_modbus(client_sax, 41, [(sax_target_value & 0xFFFF), (int(adl_pf*1000) & 0xFFFF)])

            if not mqtt_lock:
                fetch_pv_data()

            starttime = time.time()
            await send_mqtt_message(topic=f"{pm_base_topic}/battery/power", payload=sax_power, retain=True)
            await send_mqtt_message(topic=f"{pm_base_topic}/smartmeter/power/active/total", payload=adl_power, retain=True)

            if not mqtt_lock:
                await send_mqtt_message(topic=f"{pm_base_topic}/pv/power/total", payload=pv_value[1], retain=True)
                await send_mqtt_message(topic=f"{pm_base_topic}/pv/state", payload=pv_value[2], retain=True)
                await send_mqtt_message(topic=f"{pm_base_topic}/pv/day_yield", payload=pv_value[3], retain=True)
                await send_mqtt_message(topic=f"{pm_base_topic}/pv/power/dc_in", payload=pv_value[0], retain=True)

            await send_mqtt_message(topic=f"{pm_base_topic}/smartmeter/power-factor/total", payload=adl_pf, retain=True)
            await send_mqtt_message(topic=f"{pm_base_topic}/battery/target_power", payload=sax_target_value, retain=True)
            await send_mqtt_message(topic=f"{pm_base_topic}/battery/state", payload=sax_value[0], retain=True)
            await send_mqtt_message(topic=f"{pm_base_topic}/battery/soc", payload=sax_value[1], retain=True)
            await send_mqtt_message(topic=f"{pm_base_topic}/battery/smpower", payload=sax_smpower, retain=True)
            await send_mqtt_message(topic=f"{pm_base_topic}/smartmeter/voltage/A", payload=adl_value[0] * 0.1, retain=True)
            await send_mqtt_message(topic=f"{pm_base_topic}/smartmeter/voltage/B", payload=adl_value[1] * 0.1, retain=True)
            await send_mqtt_message(topic=f"{pm_base_topic}/smartmeter/voltage/C", payload=adl_value[2] * 0.1, retain=True)
            await send_mqtt_message(topic=f"{pm_base_topic}/smartmeter/current/A", payload=adl_value[3] * 0.01, retain=True)
            await send_mqtt_message(topic=f"{pm_base_topic}/smartmeter/current/B", payload=adl_value[4] * 0.01, retain=True)
            await send_mqtt_message(topic=f"{pm_base_topic}/smartmeter/current/C", payload=adl_value[5] * 0.01, retain=True)
            await send_mqtt_message(topic=f"{pm_base_topic}/smartmeter/power/active/A", payload=unsigned_to_signed(adl_value[6], 16), retain=True)
            await send_mqtt_message(topic=f"{pm_base_topic}/smartmeter/power/active/B", payload=unsigned_to_signed(adl_value[7], 16), retain=True)
            await send_mqtt_message(topic=f"{pm_base_topic}/smartmeter/power/active/C", payload=unsigned_to_signed(adl_value[8], 16), retain=True)
            #await send_mqtt_message(topic=f"{pm_base_topic}/smartmeter/power/reactive/A", payload=unsigned_to_signed(adl_value[10], 16), retain=True)
            #await send_mqtt_message(topic=f"{pm_base_topic}/smartmeter/power/reactive/B", payload=unsigned_to_signed(adl_value[11], 16), retain=True)
            #await send_mqtt_message(topic=f"{pm_base_topic}/smartmeter/power/reactive/C", payload=unsigned_to_signed(adl_value[12], 16), retain=True)
            #await send_mqtt_message(topic=f"{pm_base_topic}/smartmeter/power/reactive/total", payload=unsigned_to_signed(adl_value[13], 16), retain=True)
            #await send_mqtt_message(topic=f"{pm_base_topic}/smartmeter/power/apparent/A", payload=unsigned_to_signed(adl_value[14], 16), retain=True)
            #await send_mqtt_message(topic=f"{pm_base_topic}/smartmeter/power/apparent/B", payload=unsigned_to_signed(adl_value[15], 16), retain=True)
            #await send_mqtt_message(topic=f"{pm_base_topic}/smartmeter/power/apparent/C", payload=unsigned_to_signed(adl_value[16], 16), retain=True)
            #await send_mqtt_message(topic=f"{pm_base_topic}/smartmeter/power/apparent/total", payload=unsigned_to_signed(adl_value[17], 16), retain=True)
            await send_mqtt_message(topic=f"{pm_base_topic}/smartmeter/power-factor/A", payload=unsigned_to_signed(adl_value[18], 16) * 0.001, retain=True)
            await send_mqtt_message(topic=f"{pm_base_topic}/smartmeter/power-factor/B", payload=unsigned_to_signed(adl_value[19], 16) * 0.001, retain=True)
            await send_mqtt_message(topic=f"{pm_base_topic}/smartmeter/power-factor/C", payload=unsigned_to_signed(adl_value[20], 16) * 0.001, retain=True)
            await send_mqtt_message(topic=f"{pm_base_topic}/smartmeter/frequency", payload=adl_value[22] * 0.01, retain=True)
            await send_mqtt_message(topic=f"{pm_base_topic}/battery/request/time/actual", payload=totaltime_sax, retain=True)
            await send_mqtt_message(topic=f"{pm_base_topic}/smartmeter/request/time/actual", payload=totaltime_adl, retain=True)
            totaltime_mqtt = (time.time() - starttime) * 1000
            logging.debug(f"MQTT update in {totaltime_mqtt:.3f}ms done.")
            totaltime = (time.time() - starttime_a) * 1000
            logging.info(f"Cycle terminated in {totaltime:.3f}ms: SAX-Modbus {totaltime_sax:.3f}ms / ADL-Modbus {totaltime_adl:.3f}ms / MQTT {totaltime_mqtt:.3f}ms / Battery target power {sax_target_value}W")
            
            schedule.run_pending()

            await asyncio.sleep(args.timeout)

    except KeyboardInterrupt:
        logging.info("🛑 Processing terminated")
    except asyncio.exceptions.CancelledError:
        logging.info("🛑 Processing terminated")

    finally:
        await send_mqtt_message(topic=f"{base_availability_topic}", payload="offline", retain=False, overwrite_lock=True)
        client_sax.close()
        client_adl.close()
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        logging.info("🛑 Connections shutdown")

if __name__ == "__main__":
    args = parse_arguments()
    numeric_level = getattr(logging, args.log.upper(), None)
    if not isinstance(numeric_level, int):
        raise ValueError(f'Invalid Log-Level: {args.log}')

    logging.getLogger().setLevel(numeric_level)
    
    if args.d:
        daemonize()

    asyncio.run(main(args))

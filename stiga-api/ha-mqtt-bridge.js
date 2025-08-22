#!/usr/bin/env node

const { StigaAPIConnectionDevice, StigaAPIDeviceConnector, StigaAPIFramework } = require('../api/StigaAPI');

const mqtt = require('mqtt');

let stigaUsername = '';
let stigaPassword = '';
let brokerUrl = 'mqtt://192.168.1.2:1883';
const discoveryPrefix = 'homeassistant';

const options = {
  clientId: 'stiga-ha-mqtt-bridge',
  username: 'mqtt_user',
  password: '',
  clean: true,
  connectTimeout: 4000
};

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function displayHelp() {
    console.log(`
Stiga Home Assistant MQTT Bridge

Usage:
  ha-mqtt-bridge.js <Stiga username> <Stiga password> <HA broker url> <HA MQTT username> <HA MQTT password>
  ha-mqtt-bridge.js --help
  
Commands:
  <Stiga username>     The username of your STIGA account
  <Stiga password>     The password of your STIGA account
  <HA broker url>      The URL to your Home Assistant MQTT broker e.g. mqtt:/192.168.1.100:1883
  <HA MQTT username>   The username to access the Home Assistant MQTT broker
  <HA MQTT password>   The password to access the Home Assistant MQTT broker
`);
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

async function main() {
    const args = process.argv;
    if (args.includes('--help')) {
        displayHelp();
        process.exit(0);
    }
    args.forEach((val, index) => {
        switch (index) {
            case 2:
                stigaUsername = val;
                break;
            case 3:
                stigaPassword = val;
                break;
            case 4:
                brokerUrl = val;
                break;
            case 5:
                options.username = val;
                break;
            case 6:
                options.password = val;
                break;
            default:
                break;
        }
    });

    try {
        const framework = new StigaAPIFramework();
        if (!(await framework.load(stigaUsername, stigaPassword))) throw new Error('Framework failed to initialise');
        const { device } = framework.getDeviceAndBasePair();

        const uuid = (await device.getUuid())?.value;
        const name = (await device.getName())?.value;

        let attributesPayload = {
            // "operation_type": 'none',
            // "battery_level": 0,
            // "mow_progress": {
            //     "zone": 1,
            //     "zoneCompleted": 0,
            //     "gardenCompleted": 0,
            // },
            // "location": {
            //     "coverage": 0,
            //     "satellites": 0,
            //     "latitudeOffsetCm": 0,
            //     "longitudeOffsetCm": 0,
            //     "offsetDistance": 0,
            //     "offsetDegrees": 0,
            //     "offsetCompass": 0,
            // },
            // "network": {
            //     "network": "",
            //     "type": "",
            //     "band": 1,
            //     "rssi": 0,
            //     "rsrp": 0,
            //     "sq": 0,
            //     "rsrq": 0,
            // },
            "current_position": {
                "latitude": 0,
                "longitude": 0,
            },
            "last_position": {
                "latitude": 0,
                "longitude": 0,
            },
            // "settings": {
            //     "rainSensorEnabled": false,
            //     "rainSensorDelay": 0,
            //     "keyboardLock": false,
            //     "zoneCuttingHeightEnabled": 1,
            //     "antiTheft": false,
            //     "smartCutHeight": true,
            //     "longExit": true,
            //     "longExitMode": 0,
            //     "zoneCuttingHeightUniform": false,
            //     "unknown": 110,
            //     "pushNotifications": true,
            //     "obstacleNotifications": true
            // },
            // "schedule": {
            //     "enabled": true,
            //     "days": [],
            // },
            // "error": "",
            // "info": "",
        };

        console.log('\n=== Device with Garage Data Only ===');
        console.log(`UUID: ${uuid}`);
        console.log(`Name: ${name}`);
        console.log(`Product Code: ${(await device.getProductCode())?.value}`);
        console.log(`Serial Number: ${(await device.getSerialNumber())?.value}`);
        console.log(`Device Type: ${(await device.getDeviceType())?.value}`);
        console.log(`Firmware (cloud): ${(await device.getFirmwareVersion())?.value}`);
        console.log(`Base UUID: ${(await device.getBaseUuid())?.value}`);
        console.log(`Broker ID: ${(await device.getBrokerId())?.value}`);
        console.log(`Enabled: ${(await device.getIsEnabled())?.value}`);
        console.log(`Total Work Time: ${(await device.getTotalWorkTime())?.value} hours`);
        console.log(`Last Position: ${JSON.stringify((await device.getLastPosition())?.value)}`);
        attributesPayload.last_position = (await device.getLastPosition())?.value;
        console.log(`Connectors: ${device.getConnectorNames().join(', ') || 'none'}`);

        device.on('version', (version) => console.log(`DEVICE EVENT - VERSION: ${version.toString()}`));
        device.on('statusOperation', (status) => {
                console.log(
                    `DEVICE EVENT - STATUS (OPERATION): type=${status.type}, valid=${status.valid}, docking=${status.docking}${status.error ? ', error=' + status.error.toString() : ''}${status.info ? ', info=' + status.info.toString() : ''}`
                )
                let currentActivity = "none";
                switch (status.type) {
                    case 'MOWING':
                    case 'REACHING_FIRST_POINT':
                    case 'STORING_DATA':
                    case 'PLANNING_ONGOING':
                    case 'NAVIGATING_TO_AREA':
                    case 'CUTTING_BORDER':
                        currentActivity = "mowing";
                        break;
                    case 'GOING_HOME':
                        currentActivity = "returning";
                        break;
                    case 'WAITING_FOR_COMMAND':
                        currentActivity = "paused";
                        break;
                    case 'DOCKED':
                    case 'UPDATING':
                    case 'CHARGING':
                    case 'CALIBRATION':
                    case 'BLADES_CALIBRATING':
                        currentActivity = "docked";
                        break;
                    case 'ERROR':
                    case 'STARTUP_REQUIRED':
                    case 'BLOCKED':
                        currentActivity = "error";
                        break;
                    case 'LID_OPEN':
                    case 'UNKNOWN_24':
                        // no change
                        break;
                    default:
                        break;
                }
                const currentActivityPayload = {
                    "activity": currentActivity,
                };
                client.publish(discoveryPayload.activity_state_topic, JSON.stringify(currentActivityPayload), { retain: true });
                attributesPayload.operation_type = status.type;
                attributesPayload.error = status.error ? status.error.toString() : '';
                attributesPayload.info = status.info ? status.info.toString() : '';
                client.publish(discoveryPayload.json_attributes_topic, JSON.stringify(attributesPayload), {retain: true});
            }
        );
        device.on('statusBattery', (status) => {
                console.log(`DEVICE EVENT - STATUS (BATTERY): ${status.toString()}`);
                attributesPayload.battery_level = status.charge;
                client.publish(discoveryPayload.json_attributes_topic, JSON.stringify(attributesPayload), {retain: true});
            }
        );
        device.on('statusMowing', (status) => {
                console.log(`DEVICE EVENT - STATUS (MOWING): ${status.toString()}`);
                attributesPayload.mow_progress = status;
                client.publish(discoveryPayload.json_attributes_topic, JSON.stringify(attributesPayload), {retain: true});
            }
        );
        device.on('statusLocation', (status) => {
                console.log(`DEVICE EVENT - STATUS (LOCATION): ${status.toString()}`);
                attributesPayload.location = status;
                client.publish(discoveryPayload.json_attributes_topic, JSON.stringify(attributesPayload), {retain: true});
            }
        );
        device.on('statusNetwork', (status) => {
                console.log(`DEVICE EVENT - STATUS (NETWORK): ${status.toString()}`);
                attributesPayload.network = status;
                client.publish(discoveryPayload.json_attributes_topic, JSON.stringify(attributesPayload), {retain: true});
            }
        );
        device.on('position', (position) => {
                console.log(`DEVICE EVENT - POSITION: ${position.toString()}`);
                attributesPayload.position = position;
                attributesPayload.current_position.latitude = attributesPayload.last_position.latitude + (attributesPayload.position.offsetLatitutdeMetres / 111320);
                attributesPayload.current_position.longitude = attributesPayload.last_position.longitude + (attributesPayload.position.offsetLongitudeMetres / (111320 * Math.cos(attributesPayload.last_position.longitude * Math.PI / 180) ))
                client.publish(discoveryPayload.json_attributes_topic, JSON.stringify(attributesPayload), {retain: true});
            }
        );
        device.on('settings', (settings) => {
                console.log(`DEVICE EVENT - SETTINGS: ${settings.toString()}`);
                attributesPayload.settings = settings;
                client.publish(discoveryPayload.json_attributes_topic, JSON.stringify(attributesPayload), {retain: true});
            }
        );
        device.on('scheduleSettings', (schedule) => {
                console.log(`DEVICE EVENT - SCHEDULE: ${schedule.toString()}`);
                attributesPayload.schedule = schedule;
                client.publish(discoveryPayload.json_attributes_topic, JSON.stringify(attributesPayload), {retain: true});
            }
        );
        device.on('zoneSettings', (settings) => {
                console.log(`DEVICE EVENT - ZONE SETTINGS: ${settings.toString()}`);
                attributesPayload.zone_settings = settings;
                client.publish(discoveryPayload.json_attributes_topic, JSON.stringify(attributesPayload), {retain: true});
            }
        );
        device.on('zoneOrder', (order) => {
                console.log(`DEVICE EVENT - ZONE ORDER: ${order.toString()}`);
                attributesPayload.szone_order = order;
                client.publish(discoveryPayload.json_attributes_topic, JSON.stringify(attributesPayload), {retain: true});
            }
        );
        //device.on('dataUpdated', ({ key, source }) => console.log(`DEVICE DATA UPDATED: ${key} from ${source}`));

        console.log('\n=== Setting up Home Assistant MQTT Connection ===');
        const client = mqtt.connect(brokerUrl, options);
        const baseTopic = `${discoveryPrefix}/lawn_mower/${uuid}`;
        const baseSensorTopic = `${discoveryPrefix}/sensor/${uuid}`;
        const baseButtonTopic = `${discoveryPrefix}/button/${uuid}`;
        const baseSwitchTopic = `${discoveryPrefix}/switch/${uuid}`;
        const discoveryPayload = {
            name,
            "unique_id": uuid,
            "command_topic": `${baseTopic}/command`,
            "availability_topic": `${baseTopic}/availability`,
            "activity_state_topic": `${baseTopic}/state`,
            "activity_value_template": "{{ value_json.activity }}",
            "json_attributes_topic": `${baseTopic}/attributes`,
            "supported_features": ["start", "pause", "dock", "status"],
            "device": {
                "identifiers": [uuid],
                "manufacturer": "STIGA",
                "model_id": (await device.getProductCode())?.value,
                name,
                "serial_number": (await device.getSerialNumber())?.value,
                "sw_version": (await device.getFirmwareVersion())?.value
            },
            "o": {
                "name":"stiga2ha-mqtt",
                "sw": "0.0.1",
                "url": "https://github.com/"
            },
        };
        const discoveryBatterySensor = {
            "name": "Battery",
            "unique_id": `${uuid}_battery`,
            "state_topic": `${baseTopic}/attributes`,
            "value_template": "{{ value_json.battery_level }}",
            "unit_of_measurement": "%",
            "device_class": "battery",
            "device": {
                "identifiers": [uuid],
            }
        };
        const discoveryProgressSensor = {
            "name": "Progress",
            "unique_id": `${uuid}_progress`,
            "icon": "mdi:progress-helper",
            "state_topic": `${baseTopic}/attributes`,
            "value_template": "{{ value_json.mow_progress.gardenCompleted }}",
            "unit_of_measurement": "%",
            "device": {
                "identifiers": [uuid],
            }
        };
        const discoveryOperationModeSensor = {
            "name": "Operation Mode",
            "unique_id": `${uuid}_operation_mode`,
            "icon": "mdi:state-machine",
            "state_topic": `${baseTopic}/attributes`,
            "value_template": "{{ value_json.operation_type }}",
            "device": {
                "identifiers": [uuid],
            }
        };
        const discoveryLatitudeSensor = {
            "name": "Latitude",
            "unique_id": `${uuid}_latitude`,
            "icon": "mdi:latitude",
            "state_topic": `${baseTopic}/attributes`,
            "value_template": "{{ value_json.current_position.latitude }}",
            "device": {
                "identifiers": [uuid],
            }
        };
        const discoveryLongitudeSensor = {
            "name": "Longitude",
            "unique_id": `${uuid}_longitude`,
            "icon": "mdi:longitude",
            "state_topic": `${baseTopic}/attributes`,
            "value_template": "{{ value_json.current_position.longitude }}",
            "device": {
                "identifiers": [uuid],
            }
        };
        const discoverySatellitesSensor = {
            "name": "Satellites",
            "unique_id": `${uuid}_satellites`,
            "icon": "mdi:satellite-variant",
            "state_topic": `${baseTopic}/attributes`,
            "value_template": "{{ value_json.location.satellites }}",
            "device": {
                "identifiers": [uuid],
            }
        };
        const discoveryLocationCoverageSensor = {
            "name": "Location Coverage",
            "unique_id": `${uuid}_location_coverage`,
            "icon": "mdi:radar",
            "state_topic": `${baseTopic}/attributes`,
            "value_template": "{{ value_json.location.coverage }}",
            "device": {
                "identifiers": [uuid],
            }
        };
        const discoveryInfoSensor = {
            "name": "Info Message",
            "unique_id": `${uuid}_info_message`,
            "state_topic": `${baseTopic}/attributes`,
            "value_template": "{{ value_json.info }}",
            "device": {
                "identifiers": [uuid],
            }
        };
        const discoveryErrorSensor = {
            "name": "Error Message",
            "unique_id": `${uuid}_error_message`,
            "state_topic": `${baseTopic}/attributes`,
            "value_template": "{{ value_json.error }}",
            "device": {
                "identifiers": [uuid],
            }
        };
        const discoveryStopButton = {
            "name": "Stop",
            "icon": "mdi:pause",
            "unique_id": `${uuid}_stop`,
            "command_topic": `${baseTopic}/command`,
            "payload_press": "stop",
            "device": {
                "identifiers": [uuid],
            }
        };
        const discoveryStartButton = {
            "name": "Start",
            "icon": "mdi:play",
            "unique_id": `${uuid}_start`,
            "command_topic": `${baseTopic}/command`,
            "payload_press": "start",
            "device": {
                "identifiers": [uuid],
            }
        };
        const discoveryDockButton = {
            "name": "Go Home",
            "icon": "mdi:home-import-outline",
            "unique_id": `${uuid}_dock`,
            "command_topic": `${baseTopic}/command`,
            "payload_press": "dock",
            "device": {
                "identifiers": [uuid],
            }
        };
        const discoveryScheduleSwitch = {
            "name": "Schedule",
            "icon": "mdi:clock-outline",
            "unique_id": `${uuid}_schedule`,
            "command_topic": `${baseTopic}/command`,
            "state_topic": `${baseTopic}/attributes`,
            "payload_on": "schedule_enable",
            "payload_off": "schedule_disable",
            "state_on": "ON",
            "state_off": "OFF",
            "device_class": "switch",
            "value_template": "{{ iif(value_json.schedule.enabled, 'ON', 'OFF') }}",
            "device": {
                "identifiers": [uuid],
            }
        };

        client.publish(`${baseTopic}/config`, JSON.stringify(discoveryPayload), { retain: true });
        client.publish(`${baseSensorTopic}/battery/config`, JSON.stringify(discoveryBatterySensor), { retain: true });
        client.publish(`${baseSensorTopic}/progress/config`, JSON.stringify(discoveryProgressSensor), { retain: true });
        client.publish(`${baseSensorTopic}/operation_mode/config`, JSON.stringify(discoveryOperationModeSensor), { retain: true });
        client.publish(`${baseSensorTopic}/latitude/config`, JSON.stringify(discoveryLatitudeSensor), { retain: true });
        client.publish(`${baseSensorTopic}/longitude/config`, JSON.stringify(discoveryLongitudeSensor), { retain: true });
        client.publish(`${baseSensorTopic}/satellites/config`, JSON.stringify(discoverySatellitesSensor), { retain: true });
        client.publish(`${baseSensorTopic}/location_coverage/config`, JSON.stringify(discoveryLocationCoverageSensor), { retain: true });
        client.publish(`${baseButtonTopic}/stop/config`, JSON.stringify(discoveryStopButton), { retain: true });
        client.publish(`${baseButtonTopic}/start/config`, JSON.stringify(discoveryStartButton), { retain: true });
        client.publish(`${baseButtonTopic}/dock/config`, JSON.stringify(discoveryDockButton), { retain: true });
        client.publish(`${baseSwitchTopic}/schedule/config`, JSON.stringify(discoveryScheduleSwitch), { retain: true });
        client.publish(`${baseSensorTopic}/info/config`, JSON.stringify(discoveryInfoSensor), { retain: true });
        client.publish(`${baseSensorTopic}/error/config`, JSON.stringify(discoveryErrorSensor), { retain: true });

        console.log('\n=== Setting up MQTT Connection ===');
        const connection = new StigaAPIConnectionDevice(framework.auth, (await device.getBrokerId()).value, { debug: false });
        const connectedDevice = new StigaAPIDeviceConnector(device, connection);

        console.log(`Connectors after MQTT setup: ${device.getConnectorNames().join(', ')}`);

        console.log('Starting device listeners...');
        if (!(await connectedDevice.listen())) {
            console.error('Failed to start device listeners');
            client.publish(discoveryPayload.availability_topic, "offline");
            return;
        }

        console.log('\n=== Requesting Initial Data via Device ===');
        const version = await device.getVersion({ refresh: 'force' });
        console.log(`Version: ${version.value?.toString() || 'no data'}`);
        console.log(`  Last updated: ${new Date(version._updated).toLocaleTimeString()}`);

        client.publish(discoveryPayload.availability_topic, "online");

        // Process command from HA
        client.on('message', async (topic, message) => {
        if (topic === `${baseTopic}/command`) {
            const msg = message.toString().trim();
            console.log(`COMMAND RECEIVED by HA: ${message} in ${topic}`)
            try {
                switch (msg) {
                    case 'start': {
                        await device.sendStart();
                        console.log('Start command sent successfully');
                        break;
                    }
                    case 'stop': {
                        await device.sendStop();
                        console.log('Stop command sent successfully');
                        break;
                    }
                    case 'dock': {
                        await device.sendGoHome();
                        console.log('Dock command sent successfully');
                        break;
                    }
                    case 'schedule_enable': {
                        const schedule = await device.getScheduleSettings({ refresh: 'force' });
                        schedule.value.enabled = true;
                        await device.setScheduleSettings(schedule.value);
                        await device.getScheduleSettings({ refresh: 'force' });
                        break;
                    }
                    case 'schedule_disable': {
                        const schedule = await device.getScheduleSettings({ refresh: 'force' });
                        schedule.value.enabled = false;
                        await device.setScheduleSettings(schedule.value);
                        await device.getScheduleSettings({ refresh: 'force' });
                        break;
                    }
                }
                // Clear command
                client.publish(discoveryPayload.command_topic, "");
            } catch (e) {
                console.error('Command failed:', e.message);
            }
        }
        });

        console.log('\n=== Subcribing HA MQTT Control Topic ===');
        client.on('connect', () => {
        client.subscribe(`${baseTopic}/command`, (err) => {
            if (err) {
            console.error('Error Subscribing:', err);
            }
        });
        });

        console.log('\n=== Starting Main Loop ===');
        console.log('Press Ctrl+C to exit\n');

        let loopCount = 0;
        const mainLoop = setInterval(async () => {
            loopCount++;
            console.log(`[${new Date().toLocaleTimeString()}] Status Check #${loopCount}`);

            client.publish(discoveryPayload.availability_topic, "online");

            try {
                attributesPayload.last_position = (await device.getLastPosition({ refresh: 'force' }))?.value;
                console.log('Getting all status...');
                await device.getStatusAll({ refresh: 'ifstale' });
                await device.getPosition({ refresh: 'force' });

                if (loopCount % 20 === 1) {
                    console.log('Getting Settings...');
                    const settings = await device.getSettings({ refresh: 'force' });
                    console.log(`Settings: ${settings.value?.toString() || 'no data'}`);
                    const schedule = await device.getScheduleSettings({ refresh: 'force' });
                    console.log(`Schedule: ${schedule.value?.toString() || 'no data'}`);
                    if (schedule.value?.totalBlocks > 0) {
                        console.log('Schedule details:');
                        schedule.value.toString('blocks').forEach((block) => console.log(`  ${block}`));
                    }
                    const zoneSettings = await device.getZoneSettings({ refresh: 'force' });
                    console.log(`Zone Settings: ${zoneSettings.value?.toString() || 'no data'}`);
                    const zoneOrder = await device.getZoneOrder({ refresh: 'force' });
                    console.log(`Zone Order: ${zoneOrder.value?.toString() || 'no data'}`);
                }

            } catch (e) {
                console.error(`Error getting status:`, e.message);
            }
        }, 20000);

        process.on('SIGINT', () => {
            console.log('\n\nShutting down...');
            clearInterval(mainLoop);
            client.publish(discoveryPayload.availability_topic, "offline");
            if (connectedDevice) connectedDevice.destroy();
            connection.disconnect();
            process.exit(0);
        });
    } catch (e) {
        console.error('Error in main execution:', e);
        process.exit(1);
    }
}

main();

/*
 * vi:set sw=4 noet:
 *
 * MIT License
 *
 * Original work Copyright (c) 2018 Phillip Moon
 * Modified work Copyright 2019 Jay Schuster
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

var Service, Characteristic;
const tough = require('tough-cookie');
const got = require("got");

module.exports = function (homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    homebridge.registerPlatform("homebridge-intesisweb", "IntesisWeb", IntesisWeb);
};

/*
 * Platform code
 */
function IntesisWeb(log, config) {
    this.log = log;
    this.config = config;
    this.log.debug("IntesisWeb(log, config) called.");
}

IntesisWeb.prototype = {
    accessories: function (callback) {
	this.log.debug("IntesisWeb.accessories(callback) called.");
	const config = this.config;
	this.username = config["username"];
	this.password = config["password"];
	this.configCacheSeconds = config["configCacheSeconds"] || 30;
	this.swingMode = config["swingMode"] || "H";
	this.defaultCurrentTemp = config["defaultTemperature"] || 0;
	this.accessories = [];
	this.deviceDictionary = {};
	this.lastLogin = null;
	this.loggedIn = false;
	this.refreshConfigInProgress = false;
	this.cookieJar = new tough.CookieJar();
	this.got = got.extend({
	    prefixUrl: config["apiBaseURL"] || "https://accloud.intesis.com/",
	    resolveBodyOnly: true,
	    headers: {
		// 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Safari/605.1.15'
		'user-agent': undefined
	    }
	});
	this.setupAccessories = function (accessories) {
	    this.log("Setting up accessories/devices...");
	    callback(accessories);
	};
	this.instantiateAccessories();
    },

    doLogin: async function () {
	this.log.debug("IntesisWeb.doLogin() called.");
	var body = await this.got
	    .get("login", {cookieJar: this.cookieJar})
	    .catch((err) => {
		this.log("GET /login", err.name, err.response ? err.response.statusCode : "");
		return null;
	    });
	if (!body) {
	    this.log("Login failed. Giving up.");
	    this.loggedIn = false;
	    return this.loggedIn;
	}
	this.log.debug("GET /login OK");
	const csrf = body.match(/signin\[_csrf_token\]" value="([^"]+)"/)[1];
	body = await this.got
	    .post({
		    "url": "login",
		    "form": {
			"signin[username]": this.username,
			"signin[password]": this.password,
			"signin[_csrf_token]": csrf
		    }
		},
		{cookieJar: this.cookieJar}
	    )
	    .catch((err) => {
		this.log("POST /login", err.name, err.response ? err.response.statusCode : "");
		return err.response && 302 == err.response.statusCode ? err.response.body : null;
	    });
	if (!body) {
	    this.log("Login failed. Giving up.");
	    this.loggedIn = false;
	}
	else {
	    this.log.debug("POST /login OK");
	    this.lastLogin = new Date().getTime();
	    this.loggedIn = true;
	}
	return this.loggedIn;
    },

    getHeaders: async function () {
	this.log.debug("IntesisWeb.getHeaders() called.");
	const body = await this.got
	    .get("panel/headers", {cookieJar: this.cookieJar})
	    .catch((err) => {
		this.log("GET /panel/headers", err.name, err.response ? err.response.statusCode : "");
		return null;
	    });
	if (!body) {
	    this.loggedIn = false;
	    // Error. Not sure what to do. Try logging in again.
	}
	else if (body.match(/<title>/)) {
	    this.log.debug("GET /panel/headers LOGIN");
	    this.loggedIn = false;
	    body = null;  // Got the login page; try logging in again.
	}
	else {
	    this.log.debug("GET /panel/headers OK");
	}
	return body;
    },

    getConfig: async function () {
	this.log.debug("IntesisWeb.getConfig() called.");
	var body;
	while (!body) {
	    if (!this.loggedIn && !await this.doLogin()) {
		return null;
	    }
	    body = await this.getHeaders();
	}
	var re = /<div id="deviceHeader_(\d+)"[^]*?<div class="name left">(.*?)<\/div>/g;
	var matches;
	var devices = [ ];
	while ((matches = re.exec(body)) !== null) {
	    devices.push({
		"device_id": matches[1],
		"name": matches[2],
		"services": null
	    });
	}
	if (0 == devices.length) {
	    this.log("getConfig FAILED");
	    this.log(body);
	    return null;
	}
	var states = await Promise.all(
	    devices.map(async function (device) {
		return this.got
		    .get("panel/vista?id=" + device.device_id, {cookieJar: this.cookieJar})
		    .then((body) => {
			this.log.debug("/panel/vista?id=" + device.device_id, "OK");
			return this.getDeviceStateFromVista(body);
		    })
		    .catch((err) => {
			this.log("/panel/vista?id=" + device.device_id, err.name, err.response ? err.response.statusCode : "");
			return null;
		    });
	    }.bind(this)));
	for (let i = 0; i < states.length; i++) {
	    devices[i].services = states[i];
	}
	this.lastConfigFetch = new Date().getTime();
	this.log.debug("getConfig:");
	this.log.debug(JSON.stringify(devices, null, 2));
	return devices;
    },

    getDeviceStateFromVista: function (body) {
	const user_id = body.match(/\&userId=(\d+)/)[1];
	var services = {
	    "power": {
		"service_name": "power",
		"service_id": 1,
		"user_id": user_id,
		"value":
		    parseInt(body.match(/var selectedOnOff = (\d);/)[1], 10)
	    },
	    "userMode": {
		"service_name": "userMode",
		"service_id": 2,
		"user_id": user_id,
		"value":
		    parseInt(body.match(/var selectedUsermode = (\d);/)[1], 10)
	    },
	    "fanSpeed": {
		"service_name": "fanSpeed",
		"service_id": 4,
		"user_id": user_id,
		"value":
		    parseInt(body.match(/var selectedfanspeed = (\d);/)[1], 10)
	    },
	    "currentTemp": {
		"service_name": "currentTemp",
		"user_id": user_id,
		"units": null,
		"raw_value": null,
		"value": null,
		"defaulted": null
	    },
	    "setpointTemp": {
		"service_name": "setpointTemp",
		"service_id": 9,
		"user_id": user_id,
		/* "value": parseInt(body.match(/<span id="setPointFahrenheit_$id" class="">(\d+)<\/span>/)[1], 10) */
		"raw_value":
		    body.match(/setTempCelsiusConsignaHeader\(\d+, '(\d+.\d+)'\);/)[1],
		"value": null
	    }
	}
	services.setpointTemp.value = parseFloat(services.setpointTemp.raw_value);
	/*
	 * The thermometer can be disabled. Allow it to be defaulted.
	 */
	const current_temp = body.match(/<div class="key_value">([0-9.]+)\&deg;([FC])<\/div>/);
	if (current_temp) {
	    services.currentTemp.units = current_temp[2];
	    services.currentTemp.defaulted = 0;
	    services.currentTemp.raw_value = current_temp[1];
	}
	else if (0 != this.defaultCurrentTemp) {
	    services.currentTemp.defaulted = 1;
	    services.currentTemp.units = "C";
	    services.currentTemp.raw_value = this.defaultCurrentTemp;
	}
	else {
	    services.currentTemp.defaulted = 2;
	    services.currentTemp.units = "C";
	    services.currentTemp.raw_value = services.setpointTemp.raw_value;
	}
	/*
	 * Handle Fahrenheit vs. Celsius for currentTemp.
	 */
	services.currentTemp.value =
	    services.currentTemp.units.match(/F/)
		? (parseFloat(services.currentTemp.raw_value) - 32) * 5/9
		: parseFloat(services.currentTemp.raw_value);
	/*
	 * Vanes don't exist on all models.
	 */
	if (body.match(/var selectedhvane =/)) {
	    services["horizontalVanes"] = {
		"service_name": "horizontalVanes",
		"service_id": 6,
		"user_id": user_id,
		"value": parseInt(body.match(/var selectedhvane = (\d+);/)[1], 10)
	    };
	    if (this.swingMode != "V") {
		services["swingMode"] = {
		    "service_name": "swingMode",
		    "service_id": 6,
		    "user_id": user_id,
		    "value": services.horizontalVanes.value == 10 ? 10 : 0
		};
	    }
	}
	if (body.match(/var selectedvvane =/)) {
	    services["verticalVanes"] = {
		"service_name": "verticalVanes",
		"service_id": 5,
		"user_id": user_id,
		"value": parseInt(body.match(/var selectedvvane = (\d+);/)[1], 10)
	    };
	    if (this.swingMode == "V") {
		services["swingMode"] = {
		    "service_name": "swingMode",
		    "service_id": 5,
		    "user_id": user_id,
		    "value": services.verticalVanes.value == 10 ? 10 : 0
		};
	    }
	}
	return(services);
    },

    instantiateAccessories: async function () {
	var devices = await this.getConfig();
	if (!devices || devices.length == 0) {
	    this.log("Malformed config, skipping.");
	    return;
	}
	for (let i = 0, l = devices.length; i < l; i++) {
	    let device = devices[i];
	    let name = device.name;
	    if (!name) {
		this.log("Device had no name, not added:");
		this.log(JSON.stringify(device));
		continue;
	    }
	    else if (this.deviceDictionary[name]) {
		this.log(`"${name}" already instantiated.`);
	    }
	    else {
		this.deviceDictionary[name] = new IntesisWebDevice(this.log, device, this);
		this.accessories.push(this.deviceDictionary[name]);
		this.log(`Added "${name}" - Device ID: ${device.device_id}.`);
	    }
	}
	this.setupAccessories(this.accessories);
    },

    refreshConfig: async function (msg) {
	if (this.lastConfigFetch && (new Date().getTime() - this.lastConfigFetch) / 1000 <= this.configCacheSeconds) {
	    this.log.debug(`${msg}: Using cached data.`);
	    return;
	}
	if (this.refreshConfigInProgress) {
	    this.log.debug(`${msg}: Refresh in progress.`);
	    return;
	}
	this.refreshConfigInProgress = true;
	this.log.debug(`${msg}: Refreshing.`);
	var devices = await this.getConfig();
	if (!devices) {
	    this.log(`${msg}: Refresh FAILED.`);
	    this.refreshConfigInProgress = false;
	    return;
	}
	this.log.debug(`${msg}: Refresh successful.`);
	for (var i = 0, l = devices.length; i < l; i++) {
	    var device = devices[i];
	    var name = device.name;
	    if (!name || !this.deviceDictionary[name]) {
		continue;
	    }
	    this.deviceDictionary[name].updateData(device);
	}
	this.refreshConfigInProgress = false;
    },

    setValue: async function (userID, deviceID, serviceID, value, callback) {
	if (!userID) {
	    callback("No userID supplied.");
	    return;
	}
	if (!deviceID) {
	    callback("No deviceID supplied.");
	    return;
	}
	if (!serviceID) {
	    callback("No serviceID supplied.");
	    return;
	}
	this.log.debug("setValue:", "device/setVal?id=" + deviceID + "&uid=" + serviceID + "&value=" + value + "&userId=" + userID);
	var body = await this.got
	    .post({
		    "url": "device/setVal",
		    "headers": { "X_Requested_With": "XMLHttpRequest" },
		    "qs": {
			"id": deviceID,
			"uid": serviceID,
			"value": value,
			"userId": userID
		    }
		},
		{cookieJar: this.cookieJar}
	    )
	    .catch((err) => {
		this.log("POST", "device/setVal?id=" + deviceID + "&uid=" + serviceID + "&value=" + value + "&userId=" + userID, err.name, err.response ? err.response.statusCode : "");
		callback(err.body, null);
	    });
	this.log.debug(body);
	callback(null, body);
    }
}

/*
 * Accessory code
 */
function IntesisWebDevice(log, details, platform) {
    this.dataMap = {
	"power": {
	    /*
	     * off on
	     *	 0  1
	     */
	    "intesis": function (homekitValue) {
		let intesisMode;
		switch (homekitValue) {
		    case Characteristic.Active.ACTIVE:
			intesisMode = 1;
			break;
		    case Characteristic.Active.INACTIVE:
		    default:
			intesisMode = 0;
			break;
		}
		return intesisMode;
	    },
	    "homekit": [
		Characteristic.Active.INACTIVE,
		Characteristic.Active.ACTIVE
	    ]
	},
	"userMode": {
	    /*
	     * auto heat dry fan cool
	     *	0    1	  2   3	 4
	     */
	    "intesis": function (homekitValue) {
		let intesisMode;
		switch (homekitValue) {
		    case Characteristic.TargetHeaterCoolerState.HEAT:
			intesisMode = 1;
			break;
		    case Characteristic.TargetHeaterCoolerState.COOL:
			intesisMode = 4;
			break;
		    case Characteristic.TargetHeaterCoolerState.AUTO:
		    default:
			intesisMode = 0;
			break;
		}
		return intesisMode;
	    },
	    "homekit": [
		Characteristic.TargetHeaterCoolerState.AUTO,
		Characteristic.TargetHeaterCoolerState.HEAT,
		Characteristic.TargetHeaterCoolerState.AUTO,
		Characteristic.TargetHeaterCoolerState.AUTO,
		Characteristic.TargetHeaterCoolerState.COOL
	    ]
	},
	"fanSpeed": {
	    /*
	     * auto 1 2 3 4
	     *	 0  1 2 3 4
	     */
	    "intesis": [ 0, 1, 2, 3, 4 ],
	    "homekit": [ 0, 1, 2, 3, 4 ]
	},
	"swingMode": {
	    /*
	     * H
	     * auto swing  2 3 4 5 1
	     *	  0    10  2 3 4 5 1
	     *
	     * V
	     * auto swing  6 1 2 3 4 5
	     *	  0    10  6 1 2 3 4 5
	     */
	    "intesis": function (homekitValue) {
		return homekitValue == Characteristic.SwingMode.SWING_ENABLED
		    ? 10 : 0;
	    },
	    "homekit": function (intesisValue) {
		return intesisValue == 10
		    ? Characteristic.SwingMode.SWING_ENABLED
		    : Characteristic.SwingMode.SWING_DISABLED;
	    }
	}
    };
    this.log = log;
    this.details = details;
    this.platform = platform;
    this.name = details.name;
    this.heaterCoolerService = new Service.HeaterCooler(details.name);
    this.accessoryInfoService = new Service.AccessoryInformation();
    this.accessoryInfoService
	.setCharacteristic(Characteristic.Manufacturer, "Intesis")
	.setCharacteristic(Characteristic.Model, details.name)
	.setCharacteristic(Characteristic.SerialNumber, details.device_id);
    this.services = [this.heaterCoolerService, this.accessoryInfoService];
    this.setup(this.details);
}

IntesisWebDevice.prototype = {
    setup: function (details) {
	let services = details.services;
	let deviceID = details.device_id;
	let deviceName = details.name;
	for (var serviceName in services) {
	    this.addService(services[serviceName], deviceID, deviceName);
	}
    },

    getServices: function () {
	return this.services;
    },

    updateData: function (newDetails) {
	if (!newDetails) {
	    return;
	}
	this.details = newDetails;
	for (var serviceData in newDetails.services) {
	    switch (serviceData.service_name) {
		case "power":
		    this.heaterCoolerService
			.updateCharacteristic(Characteristic.Active,
			    this.dataMap.power.homekit[serviceData.value]);
		    break;
		case "userMode":
		    this.heaterCoolerService
			.updateCharacteristic(Characteristic.TargetHeaterCoolerState,
			    this.dataMap.userMode.homekit[serviceData.value]);
		    break;
		case "fanSpeed":
		    this.heaterCoolerService
			.updateCharacteristic(Characteristic.RotationSpeed,
			    this.dataMap.fanSpeed.homekit[serviceData.value]);
		    break;
		case "setpointTemp":
		    this.heaterCoolerService
			.updateCharacteristic(Characteristic.CoolingThresholdTemperature,
			    serviceData.value);
		    this.heaterCoolerService
			.updateCharacteristic(Characteristic.HeatingThresholdTemperature,
			    serviceData.value);
		    break;
		case "currentTemp":
		    this.heaterCoolerService
			.updateCharacteristic(Characteristic.CurrentTemperature,
			    serviceData.value);
		    break;
		case "swingMode":
		    this.heaterCoolerService
			.updateCharacteristic(Characteristic.SwingMode,
			    this.dataMap.swingMode.homekit(serviceData.value));
		    break;
	    }
	}
    },

    addService: function (service, deviceID, deviceName) {
	const serviceName = service.service_name;
	const serviceID = service.service_id;
	const userID = service.user_id;

	switch (serviceName) {
	    case "power":
		this.heaterCoolerService
		    .getCharacteristic(Characteristic.Active)
		    .on("get", callback => {
			this.platform.refreshConfig("power");
			callback(null, this.dataMap.power.homekit[this.details.services.power.value]);
		    })
		    .on("set", (value, callback) => {
			let intesisValue = this.dataMap.power.intesis(value);
			this.log(`${deviceName}: ${serviceName} SET`, value, intesisValue);
			this.platform.setValue(userID, deviceID, serviceID, intesisValue, (err, value) => {
			    if (!err) {
				this.details.services.power.value = intesisValue;
			    }
			    callback(err);
			});
		    })
		    .updateValue(this.dataMap.power.homekit[service.value]);
		break;

	    case "userMode":
		this.heaterCoolerService
		    .getCharacteristic(Characteristic.TargetHeaterCoolerState)
		    .on("get", callback => {
			this.platform.refreshConfig("userMode");
			callback(null, this.dataMap.userMode.homekit[this.details.services.userMode.value]);
		    })
		    .on("set", (value, callback) => {
			let intesisValue = this.dataMap.userMode.intesis(value);
			this.log.debug(`${deviceName}: ${serviceName} SET`, value, intesisValue);
			this.platform.setValue(userID, deviceID, serviceID, intesisValue, (err, value) => {
			    if (!err) {
				this.details.services.userMode.value = intesisValue;
			    }
			    callback(err);
			});
		    })
		    .updateValue(this.dataMap.userMode.homekit[service.value]);
		break;

	    case "fanSpeed":
		this.heaterCoolerService
		    .addCharacteristic(Characteristic.RotationSpeed)
		    .setProps({
			"maxValue": 4,
			"minValue": 0,
			"minStep": 1
		    })
		    .on("get", callback => {
			this.platform.refreshConfig("fanSpeed");
			callback(null, this.dataMap.fanSpeed.homekit[this.details.services.fanSpeed.value]);
		    })
		    .on("set", (value, callback) => {
			let intesisValue = this.dataMap.fanSpeed.intesis[value];
			this.log.debug(`${deviceName}: ${serviceName} SET`, value, intesisValue);
			this.platform.setValue(userID, deviceID, serviceID, intesisValue, (err, value) => {
			    if (!err) {
				this.details.services.fanSpeed.value = intesisValue;
			    }
			    callback(err);
			});
		    })
		    .updateValue(this.dataMap.fanSpeed.homekit[service.value]);
		break;

	    case "setpointTemp":
		var maxTemp = 35;
		var minTemp = 10;
		var step = 1;
		if (this.details.services.setpointTemp) {
		    if (this.details.services.setpointTemp.max_value) {
			maxTemp = this.details.services.setpointTemp.max_value;
		    }
		    if (this.details.services.setpointTemp.min_value) {
			minTemp = this.details.services.setpointTemp.min_value;
		    }
		    if (this.details.services.setpointTemp.step) {
			step = this.details.services.setpointTemp.step;
		    }
		}

		this.heaterCoolerService
		    .addCharacteristic(Characteristic.CoolingThresholdTemperature)
		    .setProps({
			"maxValue": maxTemp,
			"minValue": minTemp,
			"minStep": step
		    })
		    .on("get", callback => {
			this.platform.refreshConfig("setpointTemp cool");
			callback(null, this.details.services.setpointTemp.value);
		    })
		    .on("set", (value, callback) => {
			this.log.debug(`${deviceName}: ${serviceName} cool SET`, value, Math.round(value * 10));
			this.platform.setValue(userID, deviceID, serviceID, Math.round(value * 10), (err, value) => {
			    if (!err) {
				this.details.services.setpointTemp.value = value;
			    }
			    callback(err);
			});
		    })
		    .updateValue(service.value);

		this.heaterCoolerService
		    .addCharacteristic(Characteristic.HeatingThresholdTemperature)
		    .setProps({
			"maxValue": maxTemp,
			"minValue": minTemp,
			"minStep": step
		    })
		    .on("get", callback => {
			this.platform.refreshConfig("setpointTemp heat");
			callback(null, this.details.services.setpointTemp.value);
		    })
		    .on("set", (value, callback) => {
			this.log.debug(`${deviceName}: ${serviceName} heat SET`, value, Math.round(value * 10));
			this.platform.setValue(userID, deviceID, serviceID, Math.round(value * 10), (err, value) => {
			    if (!err) {
				this.details.services.setpointTemp.value = value;
			    }
			    callback(err);
			});
		    })
		    .updateValue(service.value);
		break;

	    case "currentTemp":
		this.heaterCoolerService
		    .getCharacteristic(Characteristic.CurrentTemperature)
		    .on("get", callback => {
			this.platform.refreshConfig("currentTemp");
			callback(null, this.details.services.currentTemp.value);
		    })
		    .updateValue(service.value);
		break;

	    case "swingMode":
		this.heaterCoolerService
		    .getCharacteristic(Characteristic.SwingMode)
		    .on("get", callback => {
			this.platform.refreshConfig("swingMode");
			callback(null, this.dataMap.swingMode.homekit(this.details.services.swingMode.value));
		    })
		    .on("set", (value, callback) => {
			let intesisValue = this.dataMap.swingMode.intesis(value);
			this.log.debug(`${deviceName}: ${serviceName} SET`, value, intesisValue);
			this.platform.setValue(userID, deviceID, serviceID, intesisValue, (err, value) => {
			    if (!err) {
				this.details.services.swingMode.value = intesisValue;
			    }
			    callback(err);
			});
		    })
		    .updateValue(this.dataMap.swingMode.homekit(service.value));
		break;
	}
    }
};

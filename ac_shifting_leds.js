const buffer = require('buffer');
const hid = require('node-hid')
const udp = require('dgram');
const EventEmitter = require('events');
const { abort, exit } = require('process');

// A Linux utility for the Logitech G29 wheel that connects to a running
// instance of Assetto Corsa and lights up the shifting LEDs on the wheel
// based on the engine RPM.

// Features:
// - Once running, it will attempt to auto connect to AC if the connection is lost.
// - When peak RPM is reached, it will flash the LEDs (can be disabled).

// Requirements:
// 1. NodeJS
// 2. node-hid
//
// Usage:
// 1. Run this utility as `node ac_leds.js`.
// 2. Run Assetto Corsa.

/**
 * A helper class that parses a buffer of bytes into primitive types, advancing
 * the "cursor", as primitives are extracted.
 */
class BufferReader {
  constructor(buffer) {
    this.offset = 0;
    this.buffer = buffer;
  }

  stringUtf16(length) {
    var string = this.buffer.toString('utf16le', this.offset, this.offset + length);
    // AC strings end in a `%` symbol, so strip everything after that.
    string = string.replace(/\%.*$/g, '');
    this.offset += length;
    return string;
  };

  uint32() {
    var number = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return number;
  };

  uint8() {
    var number = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return number;
  };

  float() {
    var number = this.buffer.readFloatLE(this.offset);
    this.offset += 4;
    return number;
  };

  boolean() {
    var number = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return Boolean(number);
  };

  skip(skipLen) {
    this.offset += skipLen;
  }
}

const OPERATION_ID_HANDSHAKE = 0;
const OPERATION_ID_SUBSCRIBE_UPDATE = 1;
const OPERATION_ID_SUBSCRIBE_SPOT = 2;
const OPERATION_ID_SUBSCRIBE_DISMISS = 3;

// Official specs (which are a bit outdated):
// Binary format also inferred from:
// https://github.com/bradland/ac_telemetry/blob/master/lib/ac_telemetry/bin_formats/rt_car_info.rb


/** Base class that implements a UDP client with some reconnection logic.  */
class UDPGameClient extends EventEmitter {
  udpClient;
  host;
  port;
  listenOnPort;
  reconnectTimer;
  lastMessageTimestamp;

  constructor(host, port, listenOnPort = false) {
    super();
    if (this.constructor === UDPGameClient) {
      throw new Error("Instantiate a subclass, not this class");
    }
    this.host = host;
    this.port = port;
    this.listenOnPort = listenOnPort;
  }

  connect() {
    this.disconnect();
    this.udpClient = udp.createSocket('udp4');
    var _this = this;
    this.udpClient.on('message', function (msg, info) {
      _this._processUDPMessage(msg, info);
      _this.lastMessageTimestamp = Date.now();
    });
    if (this.listenOnPort) {
      this.udpClient.bind({ port: this.port, address: this.host });
    }
    this._setupReconnectTimer();
  }

  disconnect() {
    if (this.udpClient == undefined) {
      return;
    }
    this._stopReconnectTimer();
    this.udpClient.close();
    this.udpClient = null;
  }

  sendUDPMessage(message, errorFunction = undefined) {
    if (this.udpClient != undefined) {
      this.udpClient.send(message, this.port, this.host, errorFunction);
    }
  }

  _processUDPMessage(msg, info) {
    throw new Error("Should be implemented by subclasses");
  }

  _stopReconnectTimer() {
    if (this.reconnectTimer != undefined) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  _setupReconnectTimer() {
    this._stopReconnectTimer();
    var _this = this;
    this.reconnectTimer = setInterval(function () { _this._reconnectIfNeeded(); }, 2000);
  }

  _reconnectIfNeeded() {
    // If we haven't gotten a message in the past 2 seconds, attempt a reconnect.
    if (this.lastMessageTimestamp == undefined
      || Date.now() - this.lastMessageTimestamp > 2000) {
      this.disconnect();
      this.connect();
    }
  }
}

/**
 * A class that connects to a running instance of Assetto Corsa using UDP.
 * Based on the specs from:
 * https://docs.google.com/document/d/1KfkZiIluXZ6mMhLWfDX1qAGbvhGRC3ZUzjVIt5FQpp4/pub
 *
 * Class emits 3 events:
 *   - 'connected' - when a connection is established to AC
 *   - 'disconnected' - when the connection is lost or dropped intentionally
 *   - 'carInfo' - when a message with telemetry info is received
 */
class ACClient extends UDPGameClient {
  handshakeStage = 0;

  constructor(host = 'localhost', port = 9996) {
    super(host, port);
    console.log("Connecting to Assetto Corsa");
  }

  connect() {
    super.connect();
    this._sendHandshakeRequest(OPERATION_ID_HANDSHAKE);
  }

  disconnect() {
    this.sendUDPMessage(this._handshakeRequest(OPERATION_ID_SUBSCRIBE_DISMISS));
    super.disconnect();
    this.handshakeStage = 0;
    this.emit('disconnected');
  }

  // Protected methods.

  _processUDPMessage(msg, info) {
    if (this.handshakeStage == 0) {
      this.handshakeStage++;
      var handshakeResponse = this._parseHandshakeResponse(msg);
      console.log("Assetto Corsa: subscribing to updates");
      this._sendHandshakeRequest(OPERATION_ID_SUBSCRIBE_UPDATE);
      this.emit('connected', handshakeResponse);
    } else {
      var carInfo = this._parseRTCarInfo(msg);
      this.emit('carInfo', carInfo);
    }
  }

  // Private methods.

  _sendHandshakeRequest(operationId) {
    this.sendUDPMessage(this._handshakeRequest(operationId),
      function (error) {
        if (error) {
          this.disconnect();
        }
      });
  }

  _handshakeRequest(operationId) {
    var buffer = Buffer.alloc(4 * 3);
    buffer.writeUInt32LE(0);
    buffer.writeUInt32LE(0, 4);
    buffer.writeUInt32LE(operationId, 8);
    return buffer;
  }

  _parseHandshakeResponse(msg) {
    var reader = new BufferReader(Buffer.from(msg));
    return {
      carName: reader.stringUtf16(100),
      driverName: reader.stringUtf16(100),
      identifier: reader.uint32(),
      version: reader.uint32(),
      trackName: reader.stringUtf16(100),
      trackConfig: reader.stringUtf16(100),
    };
  }

  /**
   * Based on the (outdated) info from the official spec, and the corrected spec from:
   * https://github.com/bradland/ac_telemetry/blob/master/lib/ac_telemetry/bin_formats/rt_car_info.rb
   */
  _parseRTCarInfo(msg) {
    var reader = new BufferReader(Buffer.from(msg));

    return {
      identifier: reader.uint32(),
      size: reader.uint32(),

      speed_Kmh: reader.float(),
      speed_Mph: reader.float(),
      speed_Ms: reader.float(),

      isAbsEnabled: reader.uint8(),
      isAbsInAction: reader.uint8(),
      isTcInAction: reader.uint8(),
      isTcEnabled: reader.uint8(),
      isInPit: reader.uint8(),
      isEngineLimiterOn: reader.uint8(),

      unused: reader.skip(2),

      accG_vertical: reader.float(),
      accG_horizontal: reader.float(),
      accG_frontal: reader.float(),

      lapTime: reader.uint32(),
      lastLap: reader.uint32(),
      bestLap: reader.uint32(),
      lapCount: reader.uint32(),

      gas: reader.float(),
      brake: reader.float(),
      clutch: reader.float(),
      engineRPM: reader.float(),
      steer: reader.float(),
      gear: reader.uint32(),
      cgHeight: reader.float(),

      wheelAngularSpeed: {
        a: reader.float(),
        b: reader.float(),
        c: reader.float(),
        d: reader.float(),
      },
      slipAngle: {
        a: reader.float(),
        b: reader.float(),
        c: reader.float(),
        d: reader.float(),
      },
      slipAngle_ContactPatch: {
        a: reader.float(),
        b: reader.float(),
        c: reader.float(),
        d: reader.float(),
      },
      slipRatio: {
        a: reader.float(),
        b: reader.float(),
        c: reader.float(),
        d: reader.float(),
      },
      tyreSlip: {
        a: reader.float(),
        b: reader.float(),
        c: reader.float(),
        d: reader.float(),
      },
      ndSlip: {
        a: reader.float(),
        b: reader.float(),
        c: reader.float(),
        d: reader.float(),
      },
      load: {
        a: reader.float(),
        b: reader.float(),
        c: reader.float(),
        d: reader.float(),
      },
      Dy: {
        a: reader.float(),
        b: reader.float(),
        c: reader.float(),
        d: reader.float(),
      },
      Mz: {
        a: reader.float(),
        b: reader.float(),
        c: reader.float(),
        d: reader.float(),
      },
      tyreDirtyLevel: {
        a: reader.float(),
        b: reader.float(),
        c: reader.float(),
        d: reader.float(),
      },

      camberRAD: {
        a: reader.float(),
        b: reader.float(),
        c: reader.float(),
        d: reader.float(),
      },
      tyreRadius: {
        a: reader.float(),
        b: reader.float(),
        c: reader.float(),
        d: reader.float(),
      },
      tyreLoadedRadius: {
        a: reader.float(),
        b: reader.float(),
        c: reader.float(),
        d: reader.float(),
      },

      suspensionHeight: {
        a: reader.float(),
        b: reader.float(),
        c: reader.float(),
        d: reader.float(),
      },

      carPositionNormalized: reader.float(),

      carSlope: reader.float(),

      carCoordinates: {
        x: reader.float(),
        y: reader.float(),
        z: reader.float(),
      }
    }
  }
}

/**
 * A class that accepts incoming connections from Codemasters / Dirt games.
 * Based on the specs from:
 * https://docs.google.com/spreadsheets/d/1eA518KHFowYw7tSMa-NxIFYpiWe5JXgVVQ_IMs7BVW0/edit#gid=0
 *
 * Class emits 2 events:
 *   - 'disconnected' - when the connection is lost or dropped intentionally
 *   - 'carInfo' - when a message with telemetry info is received
 */
class CodemastersClient extends UDPGameClient {
  constructor(host = 'localhost', port = 20777) {
    super(host, port, true);
    console.log("Connecting to Dirt / Codemasters");
  }

  connect() {
    super.connect();
  }

  disconnect() {
    super.disconnect();
    this.emit('disconnected');
  }

  _processUDPMessage(msg, info) {
    var reader = new BufferReader(Buffer.from(msg));
    this.emit('carInfo', {
      unused1: reader.skip(37 * 4),
      engineRPM: reader.float() * 10.0,
      unused2: reader.skip(25 * 4),
      peakRPM: reader.float() * 10.0,
    });
  }
}

/**
 * A class that processes telemetry events from `ACClient` and lights up the LEDs
 * of the Logitech G29 wheel.
 */
class ACLeds {
  acClient;
  device;
  peakRPM;
  flashLEDsTimer;
  previousLEDMask;
  LEDsOn;
  enableRedlineFlashing;
  loggedFirstMessage;

  constructor(acClient, enableRedlineFlashing = true) {
    this.acClient = acClient;
    var _this = this;
    acClient.on('connected', function (handshakeResponse) {
      _this.onConnected(handshakeResponse);
    });
    acClient.on('carInfo', function (carInfo) {
      _this.processCarInfo(carInfo);
      // Log the first message after a disconnect.
      if (!this.loggedFirstMessage) {
        console.log('Receiving data. First message:\n' + JSON.stringify(carInfo, null, ' '));
        this.loggedFirstMessage = true;
      }
    });
    acClient.on('disconnected', function () {
      this.loggedFirstMessage = false;
    })
    this.enableRedlineFlashing = enableRedlineFlashing;
  }

  start() {
    this.acClient.connect();
  }

  stop() {
    this.acClient.disconnect();
  }

  // Private methods.

  onConnected(handshakeResponse) {
    console.log(handshakeResponse);
    // Default peak RPM. This will be updated when `carInfo` messages start
    // coming in. Currently the AC protocol doesn't supply RPM range info of the cars.
    this.peakRPM = 7000;
    console.log("Peak RPM set to " + this.peakRPM);
    this.connectToWheelIfNeeded();
  }

  connectToWheelIfNeeded() {
    if (this.device != undefined) {
      return;
    }
    // Connect to the first Logitech G29.
    try {
      this.device = new hid.HID(1133, 49743);
      console.log("Connected to Logitech G29 wheel");
    } catch (e) {
      console.log("Could not open the Logitech G29 wheel");
      console.log(e);
      exit(1);
    }
  }

  processCarInfo(carInfo) {
    this.connectToWheelIfNeeded();
    this.setLEDsFromRPM(carInfo.engineRPM);
    if (carInfo.peakRPM != undefined) {
      this.peakRPM = carInfo.peakRPM;
    }
  }

  setLEDsFromRPM(rpm) {
    if (this.device == undefined) {
      return;
    }
    if (rpm > this.peakRPM) {
      this.peakRPM = rpm;
    }
    const rpmFrac = rpm / this.peakRPM;

    // Convert rpmFrac to an LED range.
    var LEDMask = 0x1;
    if (rpmFrac > 0.2) {
      LEDMask |= 0x2;
    }
    if (rpmFrac > 0.4) {
      LEDMask |= 0x4;
    }
    if (rpmFrac > 0.65) {
      LEDMask |= 0x8;
    }
    if (rpmFrac > 0.9) {
      LEDMask |= 0x10;
    }
    if (LEDMask == this.previousLEDMask) {
      return;
    }
    this.previousLEDMask = LEDMask;
    // If we're max-ed out i.e. probably redline, then flash all the LEDs.
    if (LEDMask == 0x1f && this.enableRedlineFlashing) {
      var _this = this;
      this.flashLEDsTimer = setInterval(function () { _this.flashLEDs(); }, 100);
    } else {
      if (this.flashLEDsTimer) {
        clearInterval(this.flashLEDsTimer);
        this.flashLEDsTimer = undefined;
      }
      this.device.write([0xf8, 0x12, LEDMask, 0x00, 0x00, 0x00, 0x01])
    }
  }

  flashLEDs() {
    if (this.LEDsOn) {
      this.device.write([0xf8, 0x12, 31, 0x00, 0x00, 0x00, 0x01])
    } else {
      this.device.write([0xf8, 0x12, 0, 0x00, 0x00, 0x00, 0x01])
    }
    this.LEDsOn = !this.LEDsOn;
  }
}

// Main entry point.
var dirtLEDs = new ACLeds(new CodemastersClient(), enableRedlineFlashing = true);
dirtLEDs.start();

var acLEDs = new ACLeds(new ACClient(), enableRedlineFlashing = true);
acLEDs.start();

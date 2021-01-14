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

/**
 * A class that manages a UDP connection to a running instance of Assetto Corsa.
 * Based on the specs from:
 * https://docs.google.com/document/d/1KfkZiIluXZ6mMhLWfDX1qAGbvhGRC3ZUzjVIt5FQpp4/pub
 * 
 * Class emits 3 events:
 *   - 'connected' - when a connection is established to AC
 *   - 'disconnected' - when the connection is lost or dropped intentionally
 *   - 'carInfo' - when a message with telemetry info is received
 */
class ACClient extends EventEmitter {
  udpClient;
  host;
  port;
  handshakeStage = 0;
  reconnectTimer;
  lastMessageTimestamp;

  constructor(host = 'localhost', port = 9996) {
    super();
    this.host = host;
    this.port = port;
  }

  connect() {
    if (this.udpClient) {
      this.disconnect();
    }
    this.handshakeStage = 0;
    this.udpClient = udp.createSocket('udp4');
    var _this = this;
    this.udpClient.on('message', function (msg, info) {
      _this.processUDPMessage(msg, info);
      _this.lastMessageTimestamp = Date.now();      
    });
    console.log("Connecting to Assetto Corsa at %s:%s (UDP)", this.host, this.port);
    this.sendHandshakeRequest(OPERATION_ID_HANDSHAKE);
    this.setupReconnectTimer();
  }

  disconnect() {
    if (this.udpClient == undefined) {
      return;
    }
    this.stopReconnectTimer();
    this.udpClient.send(this.handshakeRequest(OPERATION_ID_SUBSCRIBE_DISMISS), this.port, this.host);
    this.udpClient.close();
    this.udpClient = null;
    this.emit('disconnected');
  }

  // Private methods.

  stopReconnectTimer() {
    if (this.reconnectTimer != undefined) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  setupReconnectTimer() {
    this.stopReconnectTimer();
    var _this = this;
    this.reconnectTimer = setInterval(function() { _this.reconnectIfNeeded(); }, 2000);
  }

  reconnectIfNeeded() {
    // If we haven't gotten a message in the past 2 seconds, attempt a reconnect.
    if (Date.now() - this.lastMessageTimestamp > 2000) {
      this.disconnect();
      this.connect();
    }
  }

  processUDPMessage(msg, info) {
    if (this.handshakeStage == 0) {
      this.handshakeStage++;
      var handshakeResponse = this.parseHandshakeResponse(msg);
      console.log("Connected");
      this.sendHandshakeRequest(OPERATION_ID_SUBSCRIBE_UPDATE);
      this.emit('connected', handshakeResponse);
    } else {
      var carInfo = this.parseRTCarInfo(msg);
      this.emit('carInfo', carInfo);
    }
  }

  sendHandshakeRequest(operationId) {
    this.udpClient.send(this.handshakeRequest(operationId),
      this.port, this.host, function (error) {
        if (error) {
          this.disconnect();
        }
      });
  }

  handshakeRequest(operationId) {
    var buffer = Buffer.alloc(4 * 3);
    buffer.writeUInt32LE(0);
    buffer.writeUInt32LE(0, 4);
    buffer.writeUInt32LE(operationId, 8);
    return buffer;
  }

  parseHandshakeResponse(msg) {
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
  parseRTCarInfo(msg) {
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

  constructor(acClient, enableRedlineFlashing = true) {
    this.acClient = acClient;
    var _this = this;
    acClient.on('connected', function (handshakeResponse) {
      _this.onConnected(handshakeResponse);
    });
    acClient.on('carInfo', function (carInfo) {
      _this.processCarInfo(carInfo);
    });
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
    // Connect to the first Logitech G29.
    try {
      this.device = new hid.HID(1133, 49743);
      console.log("Connected to Logitech G29 wheel");
    } catch (e) {
      console.log("Could not open the Logitech G29 wheel");
      console.log(e);
      exit(1);
    }
    // Default peak RPM. This will be updated when `carInfo` messages start
    // coming in. Currently the protocol doesn't supply RPM range info of the cars.
    this.peakRPM = 7000;
    console.log("Peak RPM set to " + this.peakRPM);
  }

  processCarInfo(carInfo) {
    this.setLEDsFromRPM(carInfo.engineRPM);
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
      this.flashLEDsTimer = setInterval(function() { _this.flashLEDs(); }, 100);
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
var acClient = new ACClient();
var acLEDs = new ACLeds(acClient, enableRedlineFlashing = true);
acLEDs.start();

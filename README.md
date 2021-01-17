# Logitech G29 Shifter LEDs for Assetto Corsa & Dirt 4

A **Linux** utility for [Assetto Corsa](https://www.protondb.com/app/244210) and [Dirt 4](https://www.feralinteractive.com/en/games/dirt4/) that lights up the shifting LEDs on the Logitech G29 wheel based on the car's engine RPM.

![image of the shifting LEDs on the G29](images/shifting_leds.png?raw=true)

## Requirements
- NodeJS
  - Ubuntu: `sudo apt install nodejs`
- [node-hid](https://github.com/node-hid/node-hid)
  - `npm install node-hid`
  
## Usage

1. Download [ac_shifting_leds.js](https://github.com/d4rk/ac_shifting_leds/raw/main/ac_shifting_leds.js).

2. In terminal, launch `ac_shifting_leds.js`:
```
#:~/Downloads$ node ac_shifting_leds.js 
```

3. Then launch your game of choice and start playing.

If you switch back to the terminal, you should see some success messages:
```
Connecting to Dirt / Codemasters
Connecting to Assetto Corsa
Assetto Corsa: subscribing to updates
{
  carName: 'bmw_1m',
  driverName: 'Player',
  identifier: 4242,
  version: 1,
  trackName: 'drift',
  trackConfig: 'drift'
}
Peak RPM set to 7000
Connected to Logitech G29 wheel
Receiving data. First message:
{
 "identifier": 97,
 "size": 328,
```

## Problems

- You may get HID permission errors if the G29 isn't accessible to your user account. If that's the case,
then you may need to update your `udev` rules. See the [instructions](https://github.com/berarma/oversteer#permissions) 
in the Oversteer docs for more details.

- In Dirt 4, you will need to enable UDP telemetry data. Open the following file in your favorite text editor:
```
~/.local/share/feral-interactive/DiRT 4/VFS/User/AppData/Roaming/My Games/DiRT 4/hardwaresettings/hardware_settings_config.xml
```
and change:
```
<udp enabled="false" extradata="3" ip="127.0.0.1" port="20777" delay="1" />`
```
to
```
<udp enabled="true" extradata="3" ip="127.0.0.1" port="20777" delay="1" />`
```

## Feedback

Feel free to file issues [here](https://github.com/d4rk/ac_shifting_leds/issues).

# Assetto Corsa G29 Shifting LEDs

A Linux utility for Assetto Corsa that lights up the shifting LEDs on the Logitech G29 wheel based on the car's engine RPM.

## Requirements
- NodeJS
  - Ubuntu: `sudo apt install nodejs`
- [node-hid](https://github.com/node-hid/node-hid)
  - `npm install node-hid`
  
## Usage

In terminal, launch `ac_shifting_leds.js`:
```
#:~/Downloads$ node ac_shifting_leds.js 
```

Then launch Assetto Corsa and start playing.

If you switch back to the terminal, you should see success messages:
```
Connecting to Assetto Corsa at localhost:9996 (UDP)
Connected
{
  carName: 'bmw_1m',
  driverName: 'Player',
  identifier: 4242,
  version: 1,
  trackName: 'drift',
  trackConfig: 'drift'
}
Connected to Logitech G29 wheel
Peak RPM set to 7000
```

You may get HID permission errors if the G29 isn't accessible to your user account. If that's the case,
then you may need to update your `udev` rules. See the [instructions](https://github.com/berarma/oversteer#permissions) 
in the Oversteer docs for more details.

## Feedback

Feel free to file issues [here](https://github.com/d4rk/ac_shifting_leds/issues).

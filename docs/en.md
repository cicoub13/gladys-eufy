# eufy Security integration for Gladys Assistant

Bring your eufy Security devices into Gladys: cameras, video doorbells, smart locks, sensors (contact, motion, leak, smoke, CO) and the guard mode of HomeBases. The integration goes through the eufy cloud with the [eufy-sdk](https://github.com/mega-yfue/eufy-sdk) library.

## Features

- **Cameras and doorbells**: the image shown in the dashboard camera box is the thumbnail eufy sends with each detection or doorbell press. A scene that sends the camera image on a doorbell press waits a few seconds for it to arrive.
- **Doorbell**: a press sets the "doorbell" feature to 1, back to 0 after 5 s.
- **Motion**: each detection (motion, person, stranger, vehicle, pet, on cameras and PIR sensors) sets the motion sensor to 1, back to 0 after 30 s without a new one.
- **Locks**: lock from Gladys, battery level. Unlocking needs **Allow unlocking from Gladys** in the configuration: any Gladys user, scene or voice assistant connected to Gladys could then open the door.
- **Sensors**: door/window opening, water leak, smoke, carbon monoxide, siren active.
- **HomeBase**: read and change the guard mode (away, home, schedule, custom 1 to 3, disarmed...). Disarmed and Off need **Allow disarming from Gladys** in the configuration.
- **Battery**: level, charging, low battery alert.
- **Scenes**: "eufy doorbell pressed", "eufy motion detected" (filter on person, stranger, vehicle or pet), "eufy package delivered" and "eufy alarm triggered" triggers.

## Requirements

- **Gladys 5.1 or later.**
- A **dedicated eufy account** for Gladys. eufy keeps a single session per account: signing in with your main account would sign you out of the app. Create a second account and share your devices with it from the eufy Security app of your main account (Settings > Family & Guests), with admin rights to control locks and the guard mode. Then sign in once with the dedicated account in the eufy Security app to **accept the invitation**, and sign out: signing in with it in the app later would sign Gladys out.

## Configuration

1. Open the **Configuration** tab.
2. Enter the **email**, the **password** and the **country** (2-letter code, e.g. FR) of the dedicated account, then save.
3. Read the **connection status** at the top of the screen:
   - **Connected**: go to step 4.
   - **Verification code**: eufy emailed you a code. Type it in the **Verification code** field, then save.
   - **Captcha**: open the **Logs** of the integration and copy the line starting with `data:image/png;base64,` into the address bar of your browser to see the image. Type its 4 characters in the **Captcha answer** field, then save. eufy may then ask for a verification code.
   - **No code received, or a captcha you cannot read**: save the form again with the field empty, eufy sends a new one.
4. The integration empties the code and captcha fields once used. The session is kept: a restart asks for nothing.
5. Open the **Discovery** tab and create the devices you want.

**Test the connection** shows the status and the number of devices found. **List the raw devices** writes the model and the capabilities of each device to the logs, which helps reporting an unsupported device.

## Troubleshooting

- **Connected, but no device**: the devices are not shared with the dedicated account, or the invitation was not accepted. Share them from the eufy Security app of your main account, sign in once with the dedicated account in the app to accept, then click **Test the connection**.
- **No verification code received, or a captcha you cannot read**: save the form again with the field empty, eufy sends a new one.
- **"eufy refused the verification code"**: the code was wrong or expired. Save the form again with the field empty to get a new one.
- **"The eufy account is temporarily blocked"**: too many attempts. Wait a while without saving the form (each attempt extends the block), then save it again.
- **"Connected to eufy, but the real-time events could not start"**: the integration retries on its own, with a growing delay. Check the internet access of the Gladys server if it lasts.
- **Unlocking or disarming refused**: switch on **Allow unlocking from Gladys** or **Allow disarming from Gladys** in the configuration.
- **No camera image, or an old one**: an image only arrives with a motion or doorbell event. A scene sending the image waits a few seconds for it.
- **A device is missing**: use **List the raw devices** and open an issue with its output. The output contains the serial numbers of your devices: anonymize them before sharing it.

## Limitations

- **No live video**: Gladys only shows still images.
- A camera image is only refreshed **after an event** (motion or doorbell), and Gladys considers it expired after one hour.
- Leak, smoke and CO detection depend on what eufy reports for each model and are not confirmed on every device yet.
- If the eufy session expires (the account signed in elsewhere, for instance), the integration reconnects on its own, and eufy may ask for a code or a captcha again.

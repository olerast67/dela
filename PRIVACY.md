# Privacy

Dela has no analytics, no ads and no tracking. The apps talk only to the server whose address you enter.

## What the server stores

The server of your Dela instance stores:
- your email address and a hash of the login key derived from your password (the password itself never leaves the device);
- the list of your devices and their sessions;
- encrypted changes of your tasks and projects, with their time and size rounded to 64 bytes;
- members of shared projects;
- reminder times and push subscriptions, if you turned on reminders through Web Push;
- files attached to comments, encrypted on the device; the server knows their size and the project they belong to.

Task text, dates, labels, project names, field names and record IDs reach the server only encrypted, and the server does not have the key.

## Who runs the server

Whoever runs the server you connect to is responsible for it. The release apps contain no server address and connect only where you point them.

## Third parties

- Web Push: when you turn on push reminders, the push service of your browser vendor (Google, Mozilla, Microsoft, Apple) delivers encrypted messages from your server to your browser.
- Todoist import: the token you enter goes from your browser directly to `api.todoist.com` and is not stored.
- Windows app updates: at startup the Windows app downloads `latest.json` from the GitHub releases of this project to check for a newer version. The request carries no account data.
- Android push: if you turn on push reminders on Android, a UnifiedPush distributor app you choose (for example ntfy) delivers encrypted messages from your server. The text of a reminder is encrypted with a key only the phone knows.
- Location reminders on Android use the location of the system (GPS, and the network location provider of the phone if it has one). Dela loads no maps and looks up no addresses; coordinates stay on the phone and reach the server only inside the encrypted task. "Where I am now" in a browser asks the browser, which may use its vendor's location service.
- Voice input (the microphone button in quick add) on Android and in the Windows app records from the microphone only while you dictate and recognizes the speech on the device with a downloaded sherpa-onnx model: the audio never leaves the device and is not saved. The microphone permission on Android is asked the first time you press the button. Only if you have no speech model and choose "System recognition" on Android does Dela use the speech recognizer of the system; Dela asks it to recognize on the device, but the recognizer service (usually Google or the phone maker, for example Samsung) may send the audio online.
- Calendar subscriptions (iCal): each of your devices downloads the calendar file directly from the calendar server at the link you entered, about every 30 minutes, and keeps a copy on the device. The link is stored only inside your encrypted data; the Dela server sees neither the link nor the events. The calendar server sees the IP address of the device.
- Phone calendars on Android: with the calendar permission Dela reads the events of the calendars you choose and shows them on the phone. These events are never synced or sent anywhere.
- Pictures and voice messages shared to Dela on Android are recognized on the phone (Tesseract and sherpa-onnx) and are not sent anywhere. The recognition models are downloaded only when you press "Download" in Settings: Tesseract language data from `github.com/tesseract-ocr/tessdata_fast` and sherpa-onnx speech models from `huggingface.co/csukuangfj`. The requests carry no account data. The Windows app downloads the same speech models in the same way (Settings → Voice input) into its local data folder.
- Dela Verify, the optional browser extension, downloads the signed list of web app files for your server's version from the GitHub releases of this project.

## Deleting data

Deleted tasks go to the trash, where they can be restored. "Delete forever" and "Empty trash" overwrite every field of the task with an empty value; the server keeps only the latest value of each field, so the old encrypted text is gone from it too.

Settings → Delete account removes the account, the personal tasks and all devices from the server. Shared projects with other members pass to one of them. The daily database snapshots on the server keep the old data until they rotate out (7 days by default).

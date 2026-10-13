# Privacy

Dela has no analytics, no ads and no tracking. The apps talk only to the server whose address you enter.

## What the server stores

The server of your Dela instance stores:
- your email address and a hash of the login key derived from your password (the password itself never leaves the device);
- the list of your devices and their sessions;
- encrypted changes of your tasks and projects, with their time and size rounded to 64 bytes;
- members of shared projects;
- reminder times and push subscriptions, if you turned on reminders through Web Push.

Task text, dates, labels, project names, field names and record IDs reach the server only encrypted, and the server does not have the key.

## Who runs the server

Whoever runs the server you connect to is responsible for it. The release apps contain no server address and connect only where you point them.

## Third parties

- Web Push: when you turn on push reminders, the push service of your browser vendor (Google, Mozilla, Microsoft, Apple) delivers encrypted messages from your server to your browser.
- Todoist import: the token you enter goes from your browser directly to `api.todoist.com` and is not stored.

## Deleting data

Deleted tasks go to the trash, where they can be restored. "Delete forever" and "Empty trash" overwrite every field of the task with an empty value; the server keeps only the latest value of each field, so the old encrypted text is gone from it too.

Settings → Delete account removes the account, the personal tasks and all devices from the server. Shared projects with other members pass to one of them. The daily database snapshots on the server keep the old data until they rotate out (7 days by default).

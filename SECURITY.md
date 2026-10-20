# Security policy

Dela stores personal tasks and promises that the server cannot read them, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private reporting instead: **Security → Report a vulnerability** on this repository.

Include what you found, how to reproduce it (app or server version, platform) and what an attacker could gain. You will get an answer within a week.

## Scope

In scope:
- the code in this repository: the shared core with sync and encryption, the server, the web, Windows and Android apps;
- release files published in GitHub Releases and the Docker image `ghcr.io/olerast67/dela`;
- the build and release pipeline (`.github/workflows`).

Reports of most interest: anything that lets the server or another user read task contents, take over an account, bypass the login rate limits or two-factor login, or read another user's encrypted data.

Out of scope: a server operator who serves a modified web client (the browser loads the client from the server, so the operator controls it; the Windows and Android apps carry their own copy of the client), attacks that need a device that is already compromised, and vulnerabilities in third-party software (report those to their vendors).

## What the server can see

The list is in the Security section of the [README](README.md#security-and-privacy). If the server receives something that is not on this list, that is a vulnerability.

## Verifying a download

Each release lists SHA-256 checksums of its files in `SHA256SUMS.txt`. To check a file:

```bash
sha256sum -c SHA256SUMS.txt --ignore-missing
```

Android APKs are signed with the certificate `CN=Dela, O=olerast67` whose SHA-256 fingerprint is:

```
2C:D1:19:3E:9C:56:36:A9:20:76:4F:00:53:68:7E:06:8B:2F:93:71:DC:6D:A0:A8:AE:11:42:77:BF:B8:CC:52
```

```bash
apksigner verify --print-certs Dela-*-android.apk
```

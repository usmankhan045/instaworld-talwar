# Phase 1: FreePBX/Asterisk test host

This is the host preparation for `CALLING_IVR_PLAN.md` step 7. The Shopify app
still has no outbound call adapter. The smoke context below is for a test
softphone only and must not be connected to a public trunk or customer numbers.

## Server to create

Use a separate VPS with Debian 12, at least 2 GB RAM, 20 GB disk, a public IPv4
address, and SSH access with a key. FreePBX 17's [official download
page](https://www.freepbx.org/downloads/) specifies these minimums and links
to its Debian installer. A 2 GB RAM / 50 GB disk DigitalOcean Basic Droplet
in Singapore is a concrete test choice. Its [published Basic Droplet
price](https://www.digitalocean.com/pricing/droplets) is $12/month for
1 vCPU, 2 GB RAM and 50 GB disk as of October 2026; check the checkout total
before ordering. Do not put FreePBX on the Shopify app server.

1. In the provider's [Create Droplet
   flow](https://docs.digitalocean.com/products/droplets/how-to/create/),
   choose Singapore and **Debian 12**, not the default OS image.
2. Select SSH-key authentication. Keep the private key on your computer; never
   send it in chat or commit it to this repository.
3. Assign a memorable hostname such as `talwar-ivr-test` and note the public IP.
4. Restrict SSH (TCP 22) and the FreePBX web UI (TCP 443) to your admin IP in
   the cloud firewall. Do not open SIP or RTP to the whole internet for this
   internal test. When using a remote softphone, permit only that tester's IP
   and the ports actually configured in FreePBX, or use a private VPN.
5. Give the SSH host/IP and login user to the developer. The developer should
   verify Debian version, memory, disk, firewall, and SSH access before running
   an installer.

The VPS bill is separate from SIP call minutes and any optional backup fee.
The test host can be shut down or removed when the pilot is over.

## Install and smoke-check sequence

On the new host, use the [official FreePBX 17 Debian 12 install
instructions](https://www.freepbx.org/downloads/). Review the installer before
running it as root. Do not use a third-party one-click image or paste SIP
credentials into a terminal transcript.

After installation:

1. Complete the FreePBX admin setup and apply updates.
2. Create one PJSIP test extension for a softphone. Keep its password in the
   PBX secret store. Do not add a SIP trunk or outbound route yet.
3. Add `talwar-ivr-smoke.extensions.conf` to the host's
   `/etc/asterisk/extensions_custom.conf` without replacing existing content.
   Run `fwconsole reload`, then `asterisk -rx 'dialplan show talwar-ivr-smoke'`.
4. From a registered test softphone, originate only an internal test call to
   the smoke context. The operator may use the Asterisk CLI's `channel
   originate PJSIP/<test-extension> extension s@talwar-ivr-smoke` after
   checking the exact endpoint name with `pjsip show endpoints`.
5. Press `1`, then `2`, and perform a no-input and a mid-call hangup test.
   Inspect `TalwarIvrSmoke` events in the PBX console/AMI; ensure one event per
   completed or interrupted test and no customer call was placed.

The smoke context checks answer, DTMF and interruption event delivery. It does
not prove Urdu recordings, dynamic address audio, SIP trunk quality, outbound
caller ID, or app-to-PBX event reconciliation. Those require the later steps in
the plan and real test calls to approved numbers.

## Full standalone test context (after the smoke check)

Append `talwar-ivr-test.extensions.conf` to `extensions_custom.conf` and run
`fwconsole reload`. Verify `asterisk -rx 'dialplan show talwar-ivr-test'` shows
the complete context. Place the seven fixed Urdu WAV files under
`/var/lib/asterisk/sounds/talwar/` with the exact names in
`audio/ivr/README.md`. The standalone service generates customer-specific
audio into the private directory named by `IVR_SOUND_DIR`; run it as a user
that can create files there and that Asterisk can read.

Create an AMI account limited to the local host and to the permissions needed
for Originate and `UserEvent` delivery. Keep its secret in the host's
environment or secret store, never in this repository. Configure an outbound
test trunk with a provider-approved caller ID, and add **only your test phone
numbers** to `IVR_TEST_NUMBERS`. The service refuses live test mode without
`IVR_LIVE_TEST_CALLS=yes` and the other required settings in
`ivr-standalone/README.md`.

Run one test each for both confirmations, cancellation, wrong address, busy,
no answer, dropped call at each question, duplicate event, and an interrupted
AMI connection. Inspect the SQLite attempt record and the provider call-detail
record after each test. Never use a Shopify customer number for these tests.

## Exit gate

Step 7 is complete only when the test host is installed, its admin access is
restricted, the internal PJSIP test extension works, and the smoke tests above
pass. Do not mark the phase complete from a successful config review alone.

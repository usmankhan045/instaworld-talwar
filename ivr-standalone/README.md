# Standalone order-confirmation IVR

This service is isolated from Shopify and the app's TCS booking flow. It uses
its own SQLite file (default `var/ivr-test.sqlite`) and accepts only jobs you
create through its loopback API for numbers in `IVR_TEST_NUMBERS`. The old
Shopify `orders/create` handler is inert, and the old app DB queue worker is
disabled. No confirmation from this service can book or cancel an order.

## Run the simulator

Use Node 22.12 or newer. Set a private token of at least 24 characters and a
comma-separated list of your own test numbers:

```bash
IVR_ADMIN_TOKEN='<long-random-test-token>' \
IVR_TEST_NUMBERS='03001234567' \
npm run ivr:standalone
```

The server listens on `127.0.0.1:8787`, stores data separately in SQLite and
checks the queue every 30 seconds during 10:00–20:00 Pakistan time. The
default provider is simulated: it records call intent but never dials a phone.
You can also trigger one queue check with `POST /tick`.

All HTTP requests need `Authorization: Bearer <IVR_ADMIN_TOKEN>`. Routes:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/jobs` | Create an idempotent test job with `reference`, `customerName`, `productSummary`, `address`, `phone` |
| `GET` | `/jobs` | List recent test jobs |
| `GET` | `/jobs/<id>` | View the job and attempts, including exact spoken text |
| `POST` | `/tick` | Process one due test job |
| `POST` | `/events` | Simulate an Asterisk event with `id`, `attemptId`, `providerCallId`, `kind` |

Event kinds are `answered`, `order_1`, `order_2`, `address_1`, `address_2`,
`no_answer`, `busy`, `hangup`, `failed`, `no_input`, and `invalid_input`.
`order_1` must precede `address_1` or `address_2` in the same attempt.
Missed and dropped attempts retry the same job after 45 and 15 minutes,
respectively. The third failed attempt goes to manual review. A timed-out
origination with an uncertain outcome goes to manual review to prevent a
duplicate call. Every call begins again with both confirmation questions.

## Asterisk test mode

The adapter is present but starts only when **all** of the following are set:
`IVR_PROVIDER=asterisk`, `IVR_LIVE_TEST_CALLS=yes`, an allowlist of test
numbers, `AMI_USERNAME`, `AMI_SECRET`, `IVR_TRUNK`, `IVR_CALLER_ID`,
`PIPER_MODEL`, and `IVR_SOUND_DIR`. `AMI_HOST` defaults to loopback. The
service refuses a remote plaintext AMI connection; use the PBX host itself or
a local SSH tunnel. `IVR_CALLER_ID` must be a number verified by the test SIP
provider. `IVR_SOUND_DIR` must be a private directory under Asterisk's sounds
tree, readable by the Asterisk service user.

Install `infra/asterisk/talwar-ivr-test.extensions.conf` as a custom dialplan
context on the PBX. Add the seven fixed Urdu WAV prompts listed in
`audio/ivr/README.md` under `/var/lib/asterisk/sounds/talwar`. The service
checks that they exist before it starts. Install Piper and ffmpeg on the PBX
host; the [Urdu Fasih Piper voice](https://huggingface.co/rhasspy/piper-voices/tree/main/ur/ur_PK/fasih/medium)
is one model to evaluate with Pakistani names, mixed Urdu/English product
titles and addresses. Put its model and JSON config outside this repository.
Dynamic audio is converted to private mono 8 kHz WAV and cached by text hash.
Do not enable real test calling until prompt quality, DTMF and SIP trunk
configuration pass manual checks.

No VPS, SIP trunk, recordings or approved caller ID are present in this
repository. The Asterisk path has not been run against a real PBX yet.

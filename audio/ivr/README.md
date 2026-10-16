# Talwar Store IVR recordings

This directory is reserved for the fixed Urdu telephone prompts. Do not put
customer-specific names, products, addresses, or phone numbers in these files.

## Required files

The source scripts are defined in `app/lib/calling-audio.server.ts`:

- `order-choice.wav`
- `address-choice.wav`
- `order-confirmed.wav`
- `order-cancelled.wav`
- `no-input-retry.wav`
- `invalid-input.wav`
- `address-needs-review.wav`

Record each prompt as a clear, human Urdu voice. The final telephony format
will be selected after the SIP provider is chosen; the expected target is a
single-channel WAV format accepted by Asterisk.

Personalized greeting and address audio is generated separately per order and
must never be committed to this directory.

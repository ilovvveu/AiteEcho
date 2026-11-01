---
name: arm64 / CasaOS install report
about: Report a real arm64, NAS, SBC, or CasaOS install attempt for AiteEcho
labels: deployment,help wanted
---

## Environment

- Device / host model:
- CPU architecture: arm64 / amd64 / other
- OS / CasaOS version:
- Docker version:
- AiteEcho image tag:
- OneBot implementation: NapCat / LLOneBot / other

## Install path

- [ ] Third-party CasaOS template (this repository does not publish an official app-store package)
- [ ] Docker Compose
- [ ] Manual Docker run
- [ ] Other:

## What worked?

Describe the successful steps.

## What failed or felt unclear?

Paste only redacted logs. Do not include QQ credentials, access tokens, cookies, QR codes, or private group/user IDs.

## Validation checks

- [ ] local image built successfully
- [ ] container started
- [ ] `/healthz` responded; `/readyz` reports QQ readiness separately
- [ ] `/status` responded with the private admin Bearer header (do not paste the header or raw status)
- [ ] `/metrics` responded
- [ ] OneBot WebSocket connected
- [ ] at least one private or group message round trip worked

## Screenshots / evidence

Public screenshots are welcome, but redact:

- QQ account details
- QR codes
- access tokens
- private chat / group IDs
- personal messages

## Notes

Anything specific to CasaOS, NapCat browser login, LLOneBot, or arm64 performance?

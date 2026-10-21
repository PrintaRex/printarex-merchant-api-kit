# Merchant API contract

`merchant-api-v1.openapi.yaml` describes the PrintaRex Merchant API, version 1
(`/merchant/v1`). The sandbox serves this file at `/_sandbox/openapi.yaml`, and the
API reference at [developers.printarex.com](https://developers.printarex.com) (UAT: [uat-developers.printarex.com](https://uat-developers.printarex.com)) is
rendered from the same file.

- Additive changes (new fields, new enum values, new event types) ship inside `/v1`.
  Clients must tolerate values they do not know.
- Breaking changes get a new path (`/merchant/v2`).

**Maintainers:** this file is a copy of the public contract in the PrintaRex platform
repository (`helpcenter-portal/developers/merchant-api-v1.openapi.yaml`, the file the API
reference site serves). Change it there first, copy it here unchanged, and update the
sandbox in the same pull request. Never copy the internal planning version of the contract.

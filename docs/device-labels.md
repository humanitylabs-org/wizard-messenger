# Linked-device names

Wizard supplies **Wizard** for the WhatsApp `network.os_name`, Signal
`network.device_name`, Telegram `network.device_info.device_model` and Google
Messages `network.device_meta.os` labels. Setup output is tested too: a template
can be correct while a runtime override silently puts the old name back.

The remaining templates (Instagram, Facebook, Slack, X/Twitter, LinkedIn, LINE,
and Dots) have no analogous upstream-named pairing/device label. Internal
paths, image names, binary names and upstream attribution stay unchanged.
`upstream_template_sha256` retains the generated upstream template digest;
`template_sha256` identifies the locally branded template. Bridge binaries and
protocol identifiers are unchanged.

## Existing links

Changing a template does not rename an existing WhatsApp linked device.
The pinned WhatsApp bridge v0.2610.0 calls `store.SetOSInfo` with `os_name`.
Its pinned whatsmeow dependency (`0b0a1cdac3e2`) puts `DeviceProps` in the
**registration** payload only. Reconnect uses `getLoginPayload()` for an
existing device ID and does not send `DeviceProps`. Do not unlink an owner
account to make this label change visible. WhatsApp's owner can rename the
existing entry in **Linked devices**, or a future deliberate re-link uses the
new label.

Signal v0.2610.0 passes `Config.DeviceName` to `PerformProvisioning`; it is
encrypted into the device name sent in `/v1/devices/link`. The name remains
valid as `Wizard`; no session reset or re-provisioning is needed for the
software update, and no existing Signal device rename is claimed.

Sources:
- https://github.com/mautrix/whatsapp/blob/v0.2610.0/pkg/connector/connector.go
- https://github.com/mautrix/whatsapp/blob/v0.2610.0/go.mod
- https://github.com/tulir/whatsmeow/blob/0b0a1cdac3e2/store/clientpayload.go
- https://github.com/mautrix/signal/blob/v0.2610.0/pkg/connector/login.go
- https://github.com/mautrix/signal/blob/v0.2610.0/pkg/signalmeow/provisioning.go

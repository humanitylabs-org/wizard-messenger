# Messenger app-local components

Shared components are catalogued in [Wizard UX COMPONENTS.md](https://github.com/humanitylabs-org/wizard-ux/blob/main/docs/COMPONENTS.md). This inventory records app-local implementation where that shared catalogue has no equivalent.

| Capability | Entry point | Boundary |
|---|---|---|
| Messenger live thread cache | `store.threads`, `apply`, `restore`, `persist` in `static/unified.js` | App-local cached conversations, not Wizard agent Chats. Reuses JavaScript null-prototype objects and JSON; reserved IDs remain own data entries across startup, feed reset and cache persistence. No new storage service, UI framework or network path. |

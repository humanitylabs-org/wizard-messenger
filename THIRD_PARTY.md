# Third-party components

The application code is MIT. Bundled components retain their own licenses.

- Marmot MDK/wn/wnd: MIT, pinned revision recorded in `engine/provenance.json`. The upstream license and Cargo.lock ship in `engine/`; dependency licensing follows the pinned upstream graph.
- Bech32 reference implementation: bech32 1.2.0 / Pieter Wuille and contributors, MIT. Exact source and license are in `vendor/bech32/`. Source hash: `9f8e31649ff9dfbc97e7be4f0593690440eb8763afa515d18acc825ba995a5bc`.
- Wizard sigil renderer: Humanity Labs Wizard OS house renderer. The app reuses the chat silhouette and has candidate hue 191°. The palette contribution is staged separately from the protected platform branch.
- Runtime OS packages, including GNOME Keyring, D-Bus and GLib: Debian packages retain their upstream licensing and copyright notices. GNOME Keyring is an independent service invoked over a private session bus; its source is https://gitlab.gnome.org/GNOME/gnome-keyring. Package copyright notices remain in the image's standard `/usr/share/doc` locations.

Do not represent the entire container or upstream dependency graph as exclusively MIT. Preserve notices and source/build provenance when redistributing a candidate.

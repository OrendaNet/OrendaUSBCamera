# Orenda USB Camera

Read `../OrendaDocs/AGENTS.md` and the OrendaBoxSDK hardware and auth contracts before changing integration.

- Keep the app small: live camera video, no recording or audio without an explicit product request.
- Reuse Edge identity and the SDK USB broker. Never mount host devices, add a privileged container or bypass install-time grants.
- Keep browser URLs relative and runtime credentials server-side.
- Use `apply_patch` for manual edits. Preserve unrelated local changes.
- Run `npm test` and `npm run check`; validate release manifests with the vendored SDK.
- Releases use native ARM64 builds and immutable image digests. Confirm anonymous image pulls before activating the market listing.
- Distinguish test JPEG/virtual device checks from physical C270 verification.

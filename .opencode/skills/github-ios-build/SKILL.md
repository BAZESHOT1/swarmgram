---
name: github-ios-build
description: Build and publish the SwarmGram iOS unsigned IPA via GitHub Actions, then install with Sideloadly. Use when building iOS, debugging CI, downloading artifacts, or creating releases.
---

# GitHub iOS build (unsigned IPA)

Repository: `BAZESHOT1/swarmgram` (private).

## Prerequisites

- GitHub CLI authenticated: `gh auth status`.
- Git configured, code pushed to `main`.
- Workflow: `.github/workflows/ios-unsigned.yml`.
- BLE is native (`react-native-ble-plx`); Expo Go/Safari cannot use BLE.
  The workflow runs `expo prebuild` and CocoaPods, so no local macOS is needed.

## Build

```powershell
gh workflow run ios-unsigned.yml --ref main
gh run list --workflow=ios-unsigned.yml --limit 1
gh run watch <run-id> --interval 25 --exit-status
```

The workflow:
1. typechecks the client;
2. runs `expo prebuild --platform ios --clean --no-install`;
3. `pod install`;
4. selects the `SwarmGram` scheme;
5. builds `Release-iphoneos arm64` with `CODE_SIGNING_ALLOWED=NO`;
6. packages `Payload/SwarmGram.app` into `SwarmGram-unsigned.ipa`.

## Download

```powershell
gh run download <run-id> -n SwarmGram-unsigned-ipa -D <dest>
```

Artifact contains:
- `SwarmGram-unsigned.ipa`
- `SwarmGram-unsigned.ipa.sha256`
- `xcodebuild.log`

## Install on iPhone (no Apple Developer account)

1. Install Sideloadly on Windows/macOS.
2. Connect iPhone, drop `SwarmGram-unsigned.ipa`.
3. Enter your Apple ID; Sideloadly signs with a free certificate.
4. Trust the developer profile: Settings → General → VPN & Device Management.
5. Free signing expires in 7 days; re-sideload to renew.

## Release

```powershell
gh release create ios-vX.Y.Z SwarmGram-unsigned.ipa SwarmGram-unsigned.ipa.sha256 `
  --title "SwarmGram iOS X.Y.Z (unsigned IPA)" --notes "Sign with Sideloadly"
```

Existing release: https://github.com/BAZESHOT1/swarmgram/releases/tag/ios-v1.0.0

## Common failures

- `Unknown prop type for "onAppear"` → `npx expo install react-native-screens`
  (must be `~4.4.0` for Expo SDK 52).
- `Podfile.lock`/version mismatch → run `npx expo install --check` and pin
  expected versions before pushing.
- `No such module`/codegen → clean DerivedData; ensure RN is `0.76.9`.
- `*.app` not found → workflow must build scheme `SwarmGram`, not a Pods
  scheme (e.g. `boost`).
- Missing BLE permission → `NSBluetoothAlwaysUsageDescription` must exist in
  `app.json` and generated `Info.plist`.
- Native API URL: `https://api.swarmgram.is-a.dev/api` (fallback `https://150-251-143-212.nip.io:3443/api`; ATS blocks HTTP).

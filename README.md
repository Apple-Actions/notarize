# notarize

A GitHub Action that notarizes a macOS `.dmg`, `.pkg`, `.zip`, or `.app` with `xcrun notarytool` using an App Store Connect API key. Designed to compose with the rest of the Apple-Actions suite, and takes the same API key inputs as `upload-testflight-build` and `download-provisioning-profiles`:

- [`Apple-Actions/import-codesign-certs`](https://github.com/Apple-Actions/import-codesign-certs)
- [`Apple-Actions/download-provisioning-profiles`](https://github.com/Apple-Actions/download-provisioning-profiles)
- [`Apple-Actions/xcodebuild`](https://github.com/Apple-Actions/xcodebuild)
- [`Apple-Actions/upload-testflight-build`](https://github.com/Apple-Actions/upload-testflight-build)
- [`Apple-Actions/Example-macOS`](https://github.com/Apple-Actions/Example-macOS) (full workflow)

The action:

1. Submits the artifact with `notarytool submit`, retrying until it gets a submission ID. A `.app` is zipped with `ditto` for submission.
2. Waits with `notarytool wait <id>`, retrying interrupted or timed-out waits on the same submission instead of submitting again.
3. Prints `notarytool log` and fails if the result is not `Accepted`.
4. Staples the ticket with `stapler staple`, retrying while Apple publishes it, then runs `stapler validate`.
5. Checks the result with Gatekeeper (`spctl`) and fails unless it reports `source=Notarized Developer ID`.

## Usage

After exporting with a Developer ID signature and building a DMG, pass the DMG path from the step that built it rather than a hard-coded file name with a version in it:

```yaml
- name: Notarize DMG
  id: notarize
  uses: Apple-Actions/notarize@v1
  with:
    path: ${{ steps.dmg.outputs.path }}
    issuer-id: ${{ vars.APPSTORE_ISSUER_ID }}
    api-key-id: ${{ vars.APPSTORE_API_KEY_ID }}
    api-private-key: ${{ secrets.APPSTORE_API_PRIVATE_KEY }}
```

### What to notarize

Notarize the DMG, not the app inside it. Gatekeeper checks the ticket stapled to the container the user opens, and a DMG's ticket covers the app it contains.

### Before notarizing

- The app inside the DMG must use the hardened runtime (`codesign --options runtime`), which a Developer ID export from [`xcodebuild`](https://github.com/Apple-Actions/xcodebuild#macos-mac-app-store-and-developer-id-from-one-archive) applies.
- The DMG itself must be signed with Developer ID and a secure timestamp:

  ```sh
  codesign --sign "$IDENTITY_HASH" --timestamp App.dmg
  ```

  Sign by SHA-1 hash rather than name. A renewed certificate keeps the old one's name, so signing by name fails as ambiguous while both are in the keychain. Get the hash from the [`identities` output of `import-codesign-certs`](https://github.com/Apple-Actions/import-codesign-certs#identities).

### Pipeline order

When the same workflow also uploads to TestFlight with [`upload-testflight-build`](https://github.com/Apple-Actions/upload-testflight-build), choose the order deliberately:

- Run the DMG and notarize steps **after** the upload if a notary-service outage must not block a TestFlight upload.
- Run them **before** the upload if re-running a failed job must never upload the same build twice.

## Inputs

| Name | Description | Default |
| --- | --- | --- |
| `path` | Path to the `.dmg`, `.pkg`, `.zip`, or `.app` to notarize. A `.app` is zipped with `ditto` for submission and stapled in place. **Required.** | — |
| `issuer-id` | The App Store Connect API Key Issuer Identifier. **Required.** | — |
| `api-key-id` | The Key ID for App Store Connect API. **Required.** | — |
| `api-private-key` | The PKCS8 format Private Key for App Store Connect API. Real newlines and literal `\n` sequences are both accepted. **Required.** | — |
| `staple` | Staple the ticket to `path` after acceptance and verify it with Gatekeeper. Ignored for `.zip`, which cannot be stapled. | `true` |
| `attempts` | Attempts for each of submitting, waiting, and stapling, covering transient network and service errors and the delay before a ticket is published. Must be a positive integer. | `3` |
| `timeout` | `notarytool --timeout` for each wait (for example `30m`, `1h`). | `1h` |

## Outputs

| Name | Description |
| --- | --- |
| `submission-id` | Notary submission ID. |
| `status` | Final notary status: `Accepted`, `Invalid`, or `Rejected`. |

## Requirements

- A macOS runner with Xcode installed (e.g. `runs-on: macos-14` or newer).
- The artifact must already be signed with a Developer ID certificate and a secure timestamp (`codesign --timestamp`). A `.app` must also use the hardened runtime (`codesign --options runtime`).
- The App Store Connect API key needs the Developer role or higher.

## Caveats

- A `.zip` cannot be stapled, so `staple` is ignored for it. Gatekeeper checks the ticket online when the contents are first opened.
- A `.app` is stapled in place. If you distribute it as a zip, create the zip again after this step so it contains the stapled ticket.

## Development

```sh
yarn install
yarn all     # format, knip, lint, type-check, test, and bundle dist/index.js with esbuild
```

The bundled `dist/` directory is committed so the action can be consumed without a build step, matching the Apple-Actions convention.

## License

MIT

# Orenda USB Camera

Monitor USB cameras connected to your OrendaBox from a phone, tablet or desktop. View two cameras together, focus on one, and pause streams whenever you need. No recording or microphone access.

Built with Node.js and ordinary HTML/CSS/JavaScript, using the [OrendaBox SDK](https://github.com/OrendaNet/OrendaBoxSDK). There are no npm runtime dependencies.

## Install on a Box

1. Use DevicePlatform **0.2.46 or newer** and update Edge Manager to **0.2.41 or newer** for two live cameras.
2. Plug your cameras into the **Box**. Logitech C270 is the target camera; other cameras must support 640 × 480 UVC MJPEG.
3. Install **Orenda USB Camera** from [Orenda Apps](https://apps.orendanet.com/apps/orenda-usb-camera).
4. Approve **USB read access** and select the cameras in the installation permissions.
5. Open the app from Edge Console or OrendaConnect. Video starts automatically.

The first two approved cameras start automatically. The Box has two capture slots shared by all apps; additional cameras stay available in the grid so you can pause one and start another. Older camera-enabled Edge versions expose one live slot until updated. Camera permissions remain managed in Edge Console. A camera without a serial number may need approval again if moved to a different USB port.

## Monitor your cameras

- **Pause or resume** each camera, or use the controls for the whole view.
- **Timed pause** resumes after 1, 5 or 15 minutes. A manual pause stays paused.
- **Focus** enlarges a camera without interrupting other live views.
- **Standard** delivers up to 10 fps. **Data saver** delivers up to 5 fps, reducing video traffic while keeping the same 640 × 480 resolution.
- **Refresh cameras** after reconnecting a device or changing its grant. Already-live cameras continue playing.

The layout adapts to touch screens and narrow windows. Hidden pages release their streams and restore the previous play/pause choices when visible again. Other open viewers may keep a camera active; closing the last viewer stops capture. Controls affect your own view.

Without an approved camera, the app shows connection and permission instructions. Browser preferences are stored locally when allowed by the Edge sandbox and otherwise last for the open session.

## Develop locally

Install Node.js 20.3 or newer (Node.js 22 is used for releases):

```sh
git clone https://github.com/OrendaNet/OrendaUSBCamera.git
cd OrendaUSBCamera
npm run dev
```

Open `http://127.0.0.1:3100`. The SDK's explicit localhost development proxy supplies a development identity. Without a Box runtime, the page explains that camera access is unavailable. It does not access your laptop webcam or display pretend production video.

```sh
npm test
npm run check
```

The normal `npm start` command requires Edge proxy identity for every UI and API request; only `/health` is public. Never deploy the development proxy.

## How it works

```text
C270 → Box Linux UVC driver → Edge USB camera broker
     → app server → Edge authenticated app proxy → web browser
```

The manifest requests only `usb:read`. An administrator selects the device's stable identity. The app calls `runtime.usb.devices()` and `runtime.usb.cameraStream(id, { width: 640, height: 480, fps: 10, signal })`. Edge opens the selected V4L2 camera and checks the grant while streaming. Its bundled Python helper uses the camera's JPEG output, so no video encoder is needed.

The app relays complete JPEG frames as an HTTP multipart stream. Multiple viewers share one capture per camera, with up to eight viewers per camera. The browser uses relative `<img>` URLs inside the existing Edge app sandbox. Runtime credentials stay on the server.

The parser copies each JPEG byte once into a bounded frame buffer. Multipart delivery shares those bytes across viewers using batched writes. A slow connection finishes its current frame before receiving another; newer frames are skipped instead of building an app-side queue. A connection stalled for 10 seconds is closed. Data saver limits only that viewer's delivery rate, so it does not change another viewer's video.

Each viewer has a 15-second lease renewed by one batched status request every three seconds. Pause closes that viewer through an authenticated request; abandoned connections expire even when a browser keeps an old image request open. One user cannot stop or renew another user's viewer.

SDK contract `1.1` prevents installation on older Edge versions without the camera broker. There is no host device mount, privileged container, separate login, outbound network permission or new Box service.

## Release

The **Release camera image** GitHub workflow tests and builds natively on an ARM64 runner, publishes and signs an immutable GHCR digest, and attaches the ready-to-publish `orenda-app.json` to the source release. The base Node image is pinned by digest. The container runs as UID/GID 1000 and listens on the `HOST`/`PORT` supplied by Edge.

For the first release, the GHCR package must be public. Verify an anonymous pull of the full ARM64 image before publishing the manifest in the official Orenda workspace. Use a new package version for each release; published versions are immutable.

## Verification boundary

Automated tests cover authenticated routes, independent camera streams, data-saving delivery, bounded multipart frames, shared viewers, batched owned leases, disconnect cleanup and failure states. Browser checks exercise the Edge proxy, pause/resume and JPEGs without Huffman tables. The Edge capture helper is checked against Linux V4L2 structures and controlled device responses. **No physical C270 was connected during development.** A first-device check should confirm both cameras live, unplug/reconnect, independent permission revocation and stopping the last viewer. Only single-planar UVC MJPEG capture is supported; other camera formats are not converted.

References: [Logitech C270 specifications](https://www.logitech.com/en-us/products/webcams/c270-hd-webcam.960-000694.html), [Linux V4L2 streaming I/O](https://docs.kernel.org/userspace-api/media/v4l/mmap.html), [Orenda SDK hardware guide](https://github.com/OrendaNet/OrendaBoxSDK/blob/main/docs/hardware.md).

## License

MIT. Vendored SDK helpers retain their own MIT notice in `sdk/LICENSE`.

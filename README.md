# Orenda USB Camera

A small example app that shows live video from a **Logitech C270** connected to an OrendaBox. One page, one selected camera, a pause button. No recording or microphone access.

Built with Node.js and ordinary HTML/CSS/JavaScript, using the [OrendaBox SDK](https://github.com/OrendaNet/OrendaBoxSDK). There are no npm runtime dependencies.

## Install on a Box

1. Use DevicePlatform **0.2.46 or newer** and update Edge Manager to **0.2.39 or newer**.
2. Plug the C270 into the **Box**, not the computer displaying the web page.
3. Install **Orenda USB Camera** from [Orenda Apps](https://apps.orendanet.com).
4. Approve **USB read access** and select the camera in the installation permissions.
5. Open the app from Edge Console or OrendaConnect. Video starts automatically.

The app requests 640×480 MJPEG at up to 10 fps to keep bandwidth and CPU use modest. Use **Refresh cameras** after reconnecting a camera or changing permissions. Camera permissions remain managed in Edge Console. A camera without a serial number may need approval again if moved to a different USB port.

No camera is required to install or run the app; it shows a connection guide when none is approved. Pausing or hiding a viewer releases its stream. Other open viewers may keep the camera active. Closing the last viewer stops capture.

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

The app relays complete JPEG frames as an HTTP multipart stream. Multiple viewers share one capture; slow clients are disconnected instead of accumulating video. The browser uses a relative `<img>` URL inside the existing Edge app sandbox. Runtime credentials stay on the server.

Each viewer has a 15-second lease renewed by its status checks. Pause closes that viewer through an authenticated request; abandoned connections expire even when a browser keeps an old image request open. One user cannot stop or renew another user's viewer.

SDK contract `1.1` prevents installation on older Edge versions without the camera broker. There is no host device mount, privileged container, separate login, outbound network permission or new Box service.

## Release

The **Release camera image** GitHub workflow tests and builds natively on an ARM64 runner, publishes and signs an immutable GHCR digest, and attaches the ready-to-publish `orenda-app.json` to the source release. The base Node image is pinned by digest. The container runs as UID/GID 1000 and listens on the `HOST`/`PORT` supplied by Edge.

For the first release, the GHCR package must be public. Verify an anonymous pull of the full ARM64 image before publishing the manifest in the official Orenda workspace. Use a new package version for each release; published versions are immutable.

## Verification boundary

Automated tests cover authenticated routes, camera selection, multipart frames, shared viewers, owned viewer leases, disconnect cleanup and failure states. Real Chromium and GTK WebKit checks exercise the Edge proxy, pause/resume and JPEGs without Huffman tables. The Edge capture helper is checked against Linux V4L2 structures and controlled device responses. **No physical C270 was connected during development.** A first-device check should confirm live video, unplug/reconnect, permission revocation and stopping the last viewer. The example supports single-planar UVC MJPEG capture; other camera formats are not converted.

References: [Logitech C270 specifications](https://www.logitech.com/en-us/products/webcams/c270-hd-webcam.960-000694.html), [Linux V4L2 streaming I/O](https://docs.kernel.org/userspace-api/media/v4l/mmap.html), [Orenda SDK hardware guide](https://github.com/OrendaNet/OrendaBoxSDK/blob/main/docs/hardware.md).

## License

MIT. Vendored SDK helpers retain their own MIT notice in `sdk/LICENSE`.

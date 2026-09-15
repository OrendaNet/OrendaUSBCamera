A small, open-source OrendaBox camera viewer by Orenda.

- Live MJPEG video targeting Logitech C270 USB webcams, at 640×480 and up to 10 fps.
- Select an approved camera, pause/resume, and reconnect from one page.
- Reuses Edge Console sign-in and installation-time USB read permission.
- One camera capture shared across viewers; closes when the last viewer leaves.
- Explicit per-viewer pause and bounded expiry work when WebKit retains an image request; another user's viewer cannot be stopped or renewed.
- A failed image connection shows a retry state even when other viewers remain live.
- No recording, microphone capture, external services, or npm runtime dependencies.

Requires **DevicePlatform 0.2.46+ and Edge Manager 0.2.39+**. The SDK 1.1 manifest makes older Edge versions reject installation safely. Only Linux ARM64 is distributed. Version 0.1.2 includes the final WebKit pause and viewer error fixes.

Connect the C270 to the Box, install from Orenda Apps, approve USB read access and select the camera, then open the app through Edge Console or OrendaConnect.

No physical camera was available during development. Automated checks use controlled JPEG streams and test the V4L2 capture contract. Real Chromium and GTK WebKit pass streaming, pause/resume and JPEGs without Huffman tables. Actual C270 negotiation and USB hotplug still need a connected Box.

The attached manifest pins the exact signed container digest. Boxes must be able to pull it anonymously before this release is activated in Orenda Apps.

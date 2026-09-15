Orenda USB Camera 0.2.0 brings remote camera monitoring to phones, tablets and desktops.

- View all approved cameras in a responsive grid, with up to two cameras live at once.
- Pause or resume individual cameras or the whole view. Timed pauses resume after 1, 5 or 15 minutes.
- Focus on a camera without interrupting other live views.
- Standard mode delivers up to 10 fps; Data saver delivers up to 5 fps with the same 640 × 480 view.
- Video pauses while the page is hidden and resumes according to your previous choices.
- Refresh connected cameras without restarting cameras that are already live.
- Clear connection, permission, busy-camera and capacity states with retry controls.

Streaming reuses one capture per camera across viewers. A bounded parser copies JPEG bytes once, multipart delivery reuses those bytes, and slow viewers skip newer frames until their current frame drains. One status request covers both cameras. Runtime authorization remains checked every 500 ms without a duplicate installed-app file read.

Use **DevicePlatform 0.2.46+ and Edge Manager 0.2.41+** for two simultaneous cameras. The two capture slots are shared across the Box. Older camera-enabled Edge versions expose one live slot. Existing USB grants and Edge Console sign-in are preserved; no new permissions are requested.

Video is live only: no recording or microphone capture. Logitech C270 is the target camera; other USB cameras must support single-planar UVC MJPEG at 640 × 480. No physical C270 was available during development. Real-device format negotiation and USB hotplug still need a connected Box.

The attached manifest pins the signed ARM64 image. Published image versions remain immutable.

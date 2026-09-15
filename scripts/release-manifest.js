const fs = require('node:fs');
const { validateManifest } = require('../sdk/manifest');
const manifest = require('../orenda-app.json');
const version = require('../package.json').version;
const digest = process.env.IMAGE_DIGEST;
if (!/^sha256:[a-f0-9]{64}$/.test(digest || '')) throw new Error('Provide the published ARM64 image digest');
manifest.versions = [{
  version, image: `ghcr.io/orendanet/orenda-usb-camera@${digest}`, digest,
  architectures: ['arm64'], minPlatformVersion: '0.2.46',
  releaseNotes: 'Remote camera monitoring with a responsive multi-camera grid, individual and timed pause, pause/resume all, focus view and Data saver mode. Lower frame-copying overhead and bounded slow-viewer queues. Requires Edge Manager 0.2.41 or newer for two simultaneous cameras; older camera-enabled Edge versions support one. No recording or audio.'
}];
const errors = validateManifest(manifest, { release: true });
if (errors.length) throw new Error(errors.join('\n'));
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/orenda-app.json', `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Validated ${manifest.id} ${version} for ARM64`);

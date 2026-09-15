const fs = require('node:fs');
const { validateManifest } = require('../sdk/manifest');
const manifest = require('../orenda-app.json');
const version = require('../package.json').version;
const digest = process.env.IMAGE_DIGEST;
if (!/^sha256:[a-f0-9]{64}$/.test(digest || '')) throw new Error('Provide the published ARM64 image digest');
manifest.versions = [{
  version, image: `ghcr.io/orendanet/orenda-usb-camera@${digest}`, digest,
  architectures: ['arm64'], minPlatformVersion: '0.2.46',
  releaseNotes: 'First release: live USB camera video through approved Edge access. Logitech C270 target; 640×480 at up to 10 fps. No recording or audio. Requires Edge Manager 0.2.38 or newer.'
}];
const errors = validateManifest(manifest, { release: true });
if (errors.length) throw new Error(errors.join('\n'));
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/orenda-app.json', `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Validated ${manifest.id} ${version} for ARM64`);

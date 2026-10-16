// electron-builder hook: VMP-signs the packaged app with castlabs EVS so Spotify's
// DRM (Widevine) accepts it. Runs after packing and code-signing, before the
// installer is built — the order castlabs requires on Windows.
// Needs Python with castlabs-evs installed and a signed-in EVS account (see README).

const { execFileSync } = require('child_process');

exports.default = async function vmpSign(context) {
  if (context.electronPlatformName !== 'win32') return;
  const python = process.env.PYTHON || 'python';
  console.log(`  • VMP-signing ${context.appOutDir}`);
  try {
    execFileSync(python, ['-m', 'castlabs_evs.vmp', 'sign-pkg', context.appOutDir], { stdio: 'inherit' });
  } catch (e) {
    throw new Error('VMP signing failed. Install castlabs-evs and sign in first:\n' +
      '  pip install --upgrade castlabs-evs\n  python -m castlabs_evs.account reauth\n' + e.message);
  }
};

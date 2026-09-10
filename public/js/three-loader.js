const assetVersion =
  document.querySelector('meta[name="finaltable-asset-version"]')?.getAttribute('content') || '';
const assetQuery = assetVersion ? `?v=${encodeURIComponent(assetVersion)}` : '';

// ?no3d=1 leaves the 3D layer out, so the table can be looked at with and
// without it on a device that has no developer console.
const skip3d = new URLSearchParams(window.location.search).has('no3d');

// Load the 3D room only on desktop-sized viewports.
if (window.innerWidth > 768 && !skip3d) {
  const threeScript = document.createElement('script');
  threeScript.src = `/vendor/three/three.r128.min.js${assetQuery}`;
  threeScript.onload = () => {
    const roomScript = document.createElement('script');
    roomScript.src = `/js/room-3d.js${assetQuery}`;
    document.body.appendChild(roomScript);
  };
  document.body.appendChild(threeScript);
}

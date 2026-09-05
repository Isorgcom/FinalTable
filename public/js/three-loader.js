const assetVersion =
  document.querySelector('meta[name="finaltable-asset-version"]')?.getAttribute('content') || '';
const assetQuery = assetVersion ? `?v=${encodeURIComponent(assetVersion)}` : '';

// Load the 3D room only on desktop-sized viewports.
if (window.innerWidth > 768) {
  const threeScript = document.createElement('script');
  threeScript.src = `/vendor/three/three.r128.min.js${assetQuery}`;
  threeScript.onload = () => {
    const roomScript = document.createElement('script');
    roomScript.src = `/js/room-3d.js${assetQuery}`;
    document.body.appendChild(roomScript);
  };
  document.body.appendChild(threeScript);
}

// Scripts/admob-config.js
// Google AdMob configuration for Ghost Mesh.
//
// PASTE YOUR OWN IDs HERE before you publish:
//   production app ID:    ca-app-pub-xxxxxxxxxxxxxxxx~xxxxxxxxxx
//   banner / interstitial / rewarded unit IDs:  your own unit IDs
//
// This is a placeholder config file. The app will not attempt to fetch any ads
// until a publishable app ID is configured and AdMob is enabled in the build.
//
(function () {
  if (typeof window === "undefined") return;

  window.admob = window.admob || {};

  // Test app ID (replace with your own production app ID before publishing).
  window.admob.testAppId = "ca-app-pub-8808521207954078~9122584573";

  // No ad unit IDs configured yet — the app treats this as "ads disabled"
  // and quietly skips any ad-related UI instead of showing broken placeholders.
  window.admob.bannerUnitId = "ca-app-pub-8808521207954078/2990123456";
  window.admob.interstitialUnitId = "ca-app-pub-8808521207954078/4567891230";
  window.admob.rewardedUnitId = "ca-app-pub-8808521207954078/7890123456";
})();

package com.ghostmesh.app;

import android.webkit.JavascriptInterface;

/**
 * The only bridge between the web app and the native mesh radios.
 *
 * The web layer talks to it as `window.GhostNative`:
 *
 *   GhostNative.isSupported()          -> is BLE / Wi-Fi Direct usable here
 *   GhostNative.setGhostId(id)         -> advertise this Ghost ID over BLE
 *   GhostNative.setDisplayName(name)   -> advertise a friendly name
 *   GhostNative.startDiscovery()       -> ask permission (first time), then start
 *   GhostNative.stopDiscovery()        -> stop beaconing / scanning
 *   GhostNative.getPeers()             -> JSON array of currently reachable peers
 *   GhostNative.connect(address)       -> join that Wi-Fi Direct device
 *
 * Discovered peers are pushed *into* the page instead: MainActivity evaluates
 * `window.gmApplyNativePeers([...])`, which merges them into the same lists
 * (Chats → "Online Nearby", WiFi → "Ghosts You Can Reach") that PeerJS
 * discovery feeds, so the two can never drift apart.
 *
 * Every method is called on the WebView's Java bridge thread, so nothing here
 * touches UI or the service directly — everything is posted to the main thread.
 */
public class GhostNativeBridge {

    private final MainActivity activity;

    public GhostNativeBridge(MainActivity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public String getPlatform() {
        return "android";
    }

    @JavascriptInterface
    public boolean isSupported() {
        return activity.isNativeMeshSupported();
    }

    @JavascriptInterface
    public String getServiceUuid() {
        return BleMeshDiscovery.SERVICE_UUID.toString();
    }

    @JavascriptInterface
    public void setGhostId(String ghostId) {
        activity.postToUi(() -> activity.setNativeIdentity(ghostId, null));
    }

    @JavascriptInterface
    public void setDisplayName(String displayName) {
        activity.postToUi(() -> activity.setNativeIdentity(null, displayName));
    }

    @JavascriptInterface
    public void startDiscovery() {
        activity.postToUi(activity::requestNativeMeshStart);
    }

    @JavascriptInterface
    public void stopDiscovery() {
        activity.postToUi(activity::requestNativeMeshStop);
    }

    @JavascriptInterface
    public void connect(String address) {
        if (address == null) return;
        activity.postToUi(() -> activity.connectNativePeer(address));
    }

    @JavascriptInterface
    public String getPeers() {
        return activity.nativePeersJson();
    }

    /** Lets the page pull the peer table without waiting for the next push. */
    @JavascriptInterface
    public void refreshPeers() {
        activity.postToUi(activity::pushCurrentNativePeers);
    }
}

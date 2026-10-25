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
 * `window.gmApplyNativePeers([...])`, which feeds every list from one table —
 * the Bluetooth tab (transport "ble"), the WiFi panel's Wi-Fi Direct card
 * (transport "wifi-direct"), the every-transport "Ghosts You Can Reach" screen
 * and the Chats tab's online strip — alongside the PeerJS presence data, so the
 * WebView and the radios can never drift apart.
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

    @JavascriptInterface
    public boolean isBluetoothEnabled() {
        return activity.isBluetoothEnabled();
    }

    @JavascriptInterface
    public boolean isWifiEnabled() {
        return activity.isWifiEnabled();
    }

    /** Why is the list empty? JSON with radios, permissions and scan flags. */
    @JavascriptInterface
    public String getDiagnostics() {
        return activity.nativeMeshDiagnostics();
    }

    /** Re-asks for the nearby permissions (Android may show the prompt again). */
    @JavascriptInterface
    public void requestPermissions() {
        activity.postToUi(activity::requestNativeMeshStart);
    }

    /** Fixes a permanently denied permission: opens the app's Settings page. */
    @JavascriptInterface
    public void openAppSettings() {
        activity.postToUi(activity::openAppSettings);
    }

    /** Lets the page pull the peer table without waiting for the next push. */
    @JavascriptInterface
    public void refreshPeers() {
        activity.postToUi(activity::pushCurrentNativePeers);
    }
}

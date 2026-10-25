package com.ghostmesh.app;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.net.wifi.p2p.WifiP2pConfig;
import android.net.wifi.p2p.WifiP2pDevice;
import android.net.wifi.p2p.WifiP2pDeviceList;
import android.net.wifi.p2p.WifiP2pInfo;
import android.net.wifi.p2p.WifiP2pManager;
import android.net.wifi.p2p.WpsInfo;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.util.List;

import androidx.core.content.ContextCompat;

/**
 * Wi-Fi Direct (peer-to-peer) discovery and connection: two phones form a
 * direct link with no router and no hotspot in between.
 *
 * Ghost Mesh uses this as the *transport* for the existing WebRTC flow: the
 * p2p group gives both devices a direct local network path, and the current
 * offline handshake (QR code, or the BLE-advertised Ghost ID) still supplies
 * the identity exchange. Nothing about the chat/call protocol changes.
 *
 * Permissions:
 *  - Android 13+ : NEARBY_WIFI_DEVICES (neverForLocation) for discovery
 *  - Android 12- : ACCESS_FINE_LOCATION (Wi-Fi Direct discovery is
 *                  location-gated there)
 */
public class WifiDirectMesh {

    public interface Listener {
        void onPeer(MeshPeer peer);
        void onStatus(String message);
        void onGroupFormed(WifiP2pInfo info);
        void onConnectResult(boolean success, String message);
    }

    private static final String TAG = "GhostMeshWifiDirect";

    private final Context context;
    private final Listener listener;

    private WifiP2pManager manager;
    private WifiP2pManager.Channel channel;
    private BroadcastReceiver receiver;
    private boolean discovering = false;
    private final Handler retryHandler = new Handler(Looper.getMainLooper());
    private int discoverFailures = 0;

    public WifiDirectMesh(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
    }

    // -------------------------------------------------------------- lifecycle
    public boolean isSupported() {
        manager = (WifiP2pManager) context.getSystemService(Context.WIFI_P2P_SERVICE);
        return manager != null;
    }

    private boolean hasPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return ContextCompat.checkSelfPermission(context, Manifest.permission.NEARBY_WIFI_DEVICES)
                    == PackageManager.PERMISSION_GRANTED;
        }
        return ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    public void start() {
        if (!isSupported()) {
            listener.onStatus("Wi-Fi Direct is not available on this device");
            return;
        }
        if (!hasPermission()) {
            listener.onStatus("Nearby-devices permission missing");
            return;
        }
        if (channel == null) {
            // A dead channel (Wi-Fi toggled off, channel lost) makes every later
            // call fail with ERROR, so the framework tells us here and the next
            // discovery re-initialises it instead of staying stuck.
            channel = manager.initialize(context, Looper.getMainLooper(),
                    () -> {
                        Log.w(TAG, "Wi-Fi Direct channel disconnected — will re-init");
                        channel = null;
                    });
            if (channel == null) {
                listener.onStatus("Wi-Fi Direct is not available on this device");
                return;
            }
        }
        registerReceiverOnce();
        discoverFailures = 0;
        discoverPeers();
    }

    public boolean isDiscovering() { return discovering; }

    public void stop() {
        retryHandler.removeCallbacksAndMessages(null);
        discoverFailures = 0;
        if (manager != null && channel != null && discovering) {
            try {
                manager.stopPeerDiscovery(channel, null);
            } catch (SecurityException e) {
                Log.w(TAG, "stopPeerDiscovery denied", e);
            }
            discovering = false;
        }
        if (receiver != null) {
            try {
                context.unregisterReceiver(receiver);
            } catch (IllegalArgumentException ignored) {
                // never registered
            }
            receiver = null;
        }
    }

    private void registerReceiverOnce() {
        if (receiver != null) return;
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) {
                String action = intent.getAction();
                if (action == null) return;
                switch (action) {
                    case WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION:
                        int state = intent.getIntExtra(WifiP2pManager.EXTRA_WIFI_STATE, -1);
                        listener.onStatus(state == WifiP2pManager.WIFI_P2P_STATE_ENABLED
                                ? "Wi-Fi Direct ready" : "Turn on Wi-Fi for Wi-Fi Direct");
                        break;
                    case WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION:
                        requestPeers();
                        break;
                    case WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION:
                        requestConnectionInfo();
                        break;
                    default:
                        break;
                }
            }
        };
        IntentFilter filter = new IntentFilter();
        filter.addAction(WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION);
        filter.addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION);
        filter.addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION);
        filter.addAction(WifiP2pManager.WIFI_P2P_THIS_DEVICE_CHANGED_ACTION);
        // Android 14+ requires an explicit export flag for receivers that are
        // registered at runtime; the p2p broadcasts are system broadcasts, so
        // NOT_EXPORTED is both correct and safe here.
        ContextCompat.registerReceiver(context, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    // -------------------------------------------------------------- discovery
    public void discoverPeers() {
        if (manager == null || channel == null || !hasPermission()) return;
        try {
            manager.discoverPeers(channel, new WifiP2pManager.ActionListener() {
                @Override
                public void onSuccess() {
                    discovering = true;
                    discoverFailures = 0;
                    listener.onStatus("Looking for Wi-Fi Direct devices");
                }

                @Override
                public void onFailure(int reason) {
                    // 0 ERROR (usually a dead channel), 2 BUSY (a previous
                    // discovery is still settling). Both are transient — Wi-Fi
                    // Direct itself simply refuses a second request too soon.
                    if (reason == WifiP2pManager.BUSY || reason == WifiP2pManager.ERROR) {
                        scheduleDiscoverRetry(reason);
                        return;
                    }
                    // 1 P2P_UNSUPPORTED
                    listener.onStatus("Wi-Fi Direct is not supported on this phone");
                }
            });
        } catch (SecurityException e) {
            Log.w(TAG, "discoverPeers denied", e);
            listener.onStatus("Nearby-devices permission missing");
        }
    }

    private void scheduleDiscoverRetry(int reason) {
        if (discoverFailures >= 4) {
            listener.onStatus("Wi-Fi Direct stayed busy — turn Wi-Fi off and on");
            return;
        }
        discoverFailures++;
        long delay = 2000L * discoverFailures;
        Log.i(TAG, "Wi-Fi Direct retry in " + (delay / 1000) + "s (reason " + reason + ")");
        if (reason == WifiP2pManager.ERROR && manager != null) {
            // The channel died: rebuild it before asking again.
            channel = manager.initialize(context, Looper.getMainLooper(), null);
        }
        retryHandler.postDelayed(this::discoverPeers, delay);
    }

    private void requestPeers() {
        if (manager == null || channel == null || !hasPermission()) return;
        try {
            manager.requestPeers(channel, peers -> {
                if (peers == null) return;
                for (WifiP2pDevice device : peers.getDeviceList()) {
                    // Wi-Fi Direct discovery has no app payload, so the device
                    // name is the only label available here. The Ghost ID is
                    // exchanged afterwards (QR handshake, or the Ghost ID the
                    // other phone advertises over BLE).
                    String name = device.deviceName == null ? "" : device.deviceName;
                    String slug = name.toLowerCase().replaceAll("[^a-z0-9]+", "-");
                    if (slug.isEmpty()) slug = device.deviceAddress.replace(":", "");
                    listener.onPeer(new MeshPeer("wifi-direct-" + slug, name,
                            device.deviceAddress, 0, "wifi-direct"));
                }
            });
        } catch (SecurityException e) {
            Log.w(TAG, "requestPeers denied", e);
        }
    }

    private void requestConnectionInfo() {
        if (manager == null || channel == null || !hasPermission()) return;
        try {
            manager.requestConnectionInfo(channel, info -> {
                if (info != null && info.groupFormed) listener.onGroupFormed(info);
            });
        } catch (SecurityException e) {
            Log.w(TAG, "requestConnectionInfo denied", e);
        }
    }

    // -------------------------------------------------------------- connecting
    /** Joins the peer's p2p group. `address` comes from the peer list above. */
    public void connect(final String address, final Listener resultListener) {
        if (manager == null || channel == null) {
            resultListener.onConnectResult(false, "Wi-Fi Direct is not ready");
            return;
        }
        if (!hasPermission()) {
            resultListener.onConnectResult(false, "Nearby-devices permission missing");
            return;
        }
        // Discovery and connect cannot run at the same time: the system answers
        // connect with BUSY (2) while a discovery is still active.
        try {
            if (discovering) {
                manager.stopPeerDiscovery(channel, null);
                discovering = false;
            }
        } catch (SecurityException ignored) {
            // permission is checked above
        }
        WifiP2pConfig config = new WifiP2pConfig();
        config.deviceAddress = address;
        config.wps.setup = WpsInfo.PBC;   // no PIN typing, matching the app's one-tap feel
        config.groupOwnerIntent = 3;
        try {
            manager.connect(channel, config, new WifiP2pManager.ActionListener() {
                @Override
                public void onSuccess() {
                    resultListener.onConnectResult(true, "Wi-Fi Direct link requested");
                }

                @Override
                public void onFailure(int reason) {
                    resultListener.onConnectResult(false, "Wi-Fi Direct connect failed (" + reason + ")");
                }
            });
        } catch (SecurityException e) {
            Log.w(TAG, "connect denied", e);
            resultListener.onConnectResult(false, "Wi-Fi Direct permission denied");
        }
    }

    /** Cancels any group this app joined (used when the service stops). */
    public void disconnect() {
        if (manager == null || channel == null) return;
        try {
            manager.removeGroup(channel, null);
        } catch (SecurityException e) {
            Log.w(TAG, "removeGroup denied", e);
        }
    }
}

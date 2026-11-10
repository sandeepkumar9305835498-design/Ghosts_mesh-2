package com.ghostmesh.app;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.util.Log;

import java.util.ArrayDeque;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Local-network peer discovery over Android's native NSD (Network Service
 * Discovery, DNS-SD / Bonjour under the hood).
 *
 * This is the "same Wi-Fi" transport: every phone running Ghost Mesh registers a
 * `_ghostmesh._tcp` service, and every phone browses for the same type. That is
 * how a device appears in the Online Users list and as a blip on the Radar Map
 * without either phone knowing the other's Ghost ID in advance.
 *
 * NSD gives us host + port + a TXT record, not a GPS fix. The TXT record carries
 * the peer's Ghost ID and display name; coordinates are filled in by the web
 * layer (it offsets the blip near the phone's own location when no real GPS fix
 * was shared).
 *
 * Registration is best effort: on a network where multicast is blocked (some
 * guest/enterprise Wi-Fi) discovery simply finds nobody and the app keeps
 * working over PeerJS + QR pairing.
 */
public class NsdDiscovery {

    private static final String TAG = "GhostMeshNsd";

    /** Service type browsed/advertised. Must end with a dot. */
    public static final String SERVICE_TYPE = "_ghostmesh._tcp.";

    private static final String TXT_ID = "id";
    private static final String TXT_NAME = "name";
    /** Advertised port. Messages travel over the app's own chat channel; this
     *  port only identifies the service instance on the network. */
    private static final int ADVERTISED_PORT = 8988;

    public interface Listener {
        /** A peer was resolved: key/ghost id, display name, host and port. */
        void onPeer(String peerId, String name, String host, int port);

        /** A peer stopped advertising (left the network / closed the app). */
        void onPeerLost(String peerId);

        /** Human readable state for the in-app status line. */
        void onState(String state);
    }

    private final Context context;
    private final Listener listener;
    private final NsdManager nsdManager;

    private WifiManager.MulticastLock multicastLock;
    private NsdManager.RegistrationListener registrationListener;
    private NsdManager.DiscoveryListener discoveryListener;

    /** NSD only allows one resolve at a time; service found events queue here. */
    private final ArrayDeque<NsdServiceInfo> resolveQueue = new ArrayDeque<>();
    private boolean resolving = false;
    private boolean running = false;

    /** service instance name -> ghost id, so onServiceLost can remove the peer. */
    private final Map<String, String> serviceToPeer = new LinkedHashMap<>();

    private String ownServiceName = "";
    private String ghostId = "";
    private String displayName = "";

    public NsdDiscovery(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
        this.nsdManager = (NsdManager) this.context.getSystemService(Context.NSD_SERVICE);
    }

    public boolean isSupported() {
        return nsdManager != null;
    }

    public boolean isRunning() {
        return running;
    }

    /** Advertise this device and start scanning. Safe to call repeatedly. */
    public void start(String ghostId, String displayName) {
        if (nsdManager == null) {
            state("Network discovery is not available on this device");
            return;
        }
        this.ghostId = ghostId == null ? "" : ghostId.trim();
        this.displayName = displayName == null ? "" : displayName.trim();
        if (running) {
            // Identity may have changed (profile rename) — re-register so the
            // advertised name stays correct.
            stop();
        }
        acquireMulticastLock();
        register();
        discover();
        running = true;
        state("Looking for Ghosts on this Wi-Fi");
    }

    /** Stop advertising and scanning. Safe to call when not running. */
    public void stop() {
        running = false;
        resolveQueue.clear();
        resolving = false;
        serviceToPeer.clear();
        releaseRegistration();
        releaseDiscovery();
        releaseMulticastLock();
    }

    /** Re-register with a new display name (profile rename). */
    public void updateIdentity(String ghostId, String displayName) {
        if (!running) return;
        this.ghostId = ghostId == null ? "" : ghostId.trim();
        this.displayName = displayName == null ? "" : displayName.trim();
        releaseRegistration();
        register();
    }

    // ------------------------------------------------------------------
    // Registration (advertise this phone)
    // ------------------------------------------------------------------
    private void register() {
        NsdServiceInfo info = new NsdServiceInfo();
        // A unique instance name keeps two phones from fighting over "Ghost".
        ownServiceName = "gm-" + sanitize(ghostId) + "-" + (System.currentTimeMillis() % 100000);
        info.setServiceName(ownServiceName);
        info.setServiceType(SERVICE_TYPE);
        info.setPort(ADVERTISED_PORT);
        try {
            if (!ghostId.isEmpty()) info.setAttribute(TXT_ID, ghostId);
            if (!displayName.isEmpty()) info.setAttribute(TXT_NAME, displayName);
        } catch (IllegalArgumentException e) {
            Log.w(TAG, "TXT record too large, advertising without it", e);
        }

        registrationListener = new NsdManager.RegistrationListener() {
            @Override public void onServiceRegistered(NsdServiceInfo registered) {
                ownServiceName = registered.getServiceName();
                Log.i(TAG, "Advertising as " + ownServiceName);
                listener.onState("Visible to nearby Ghosts");
            }

            @Override public void onRegistrationFailed(NsdServiceInfo failed, int errorCode) {
                Log.w(TAG, "NSD registration failed: " + errorCode);
                listener.onState("Could not advertise on this Wi-Fi");
            }

            @Override public void onServiceUnregistered(NsdServiceInfo unregistered) { }

            @Override public void onUnregistrationFailed(NsdServiceInfo serviceInfo, int errorCode) { }
        };

        try {
            nsdManager.registerService(info, NsdManager.PROTOCOL_DNS_SD, registrationListener);
        } catch (IllegalArgumentException e) {
            Log.w(TAG, "registerService rejected", e);
        }
    }

    private void releaseRegistration() {
        if (registrationListener == null) return;
        try {
            nsdManager.unregisterService(registrationListener);
        } catch (IllegalArgumentException ignored) {
            // already unregistered
        }
        registrationListener = null;
    }

    // ------------------------------------------------------------------
    // Discovery (find other phones)
    // ------------------------------------------------------------------
    private void discover() {
        discoveryListener = new NsdManager.DiscoveryListener() {
            @Override public void onDiscoveryStarted(String serviceType) {
                Log.i(TAG, "Browsing " + serviceType);
            }

            @Override public void onServiceFound(NsdServiceInfo serviceInfo) {
                if (serviceInfo == null) return;
                String type = serviceInfo.getServiceType();
                if (type != null && !type.startsWith("_ghostmesh")) return;
                enqueueResolve(serviceInfo);
            }

            @Override public void onServiceLost(NsdServiceInfo serviceInfo) {
                if (serviceInfo == null) return;
                String peerId = serviceToPeer.remove(serviceInfo.getServiceName());
                if (peerId != null) listener.onPeerLost(peerId);
            }

            @Override public void onDiscoveryStopped(String serviceType) { }

            @Override public void onStartDiscoveryFailed(String serviceType, int errorCode) {
                Log.w(TAG, "NSD start failed: " + errorCode);
                // 3 = ALREADY_ACTIVE, 1 = INTERNAL_ERROR: a stop/start cycle fixes
                // the stuck case on several OEM builds.
                try { nsdManager.stopServiceDiscovery(this); } catch (IllegalArgumentException ignored) { }
                listener.onState("Could not scan the local network");
            }

            @Override public void onStopDiscoveryFailed(String serviceType, int errorCode) { }
        };

        try {
            nsdManager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener);
        } catch (IllegalArgumentException e) {
            Log.w(TAG, "discoverServices rejected", e);
        }
    }

    private void releaseDiscovery() {
        if (discoveryListener == null) return;
        try {
            nsdManager.stopServiceDiscovery(discoveryListener);
        } catch (IllegalArgumentException ignored) {
            // already stopped
        }
        discoveryListener = null;
    }

    /**
     * Resolve services one after another. Calling resolveService concurrently
     * fails with FAILURE_ALREADY_ACTIVE on every Android version, which used to
     * make the second nearby phone invisible.
     */
    private synchronized void enqueueResolve(NsdServiceInfo info) {
        // Our own advertisement also shows up in the browse results.
        if (info.getServiceName() != null && info.getServiceName().equals(ownServiceName)) return;
        resolveQueue.add(info);
        drainResolveQueue();
    }

    private synchronized void drainResolveQueue() {
        if (resolving) return;
        final NsdServiceInfo next = resolveQueue.poll();
        if (next == null) return;
        resolving = true;

        nsdManager.resolveService(next, new NsdManager.ResolveListener() {
            @Override public void onResolveFailed(NsdServiceInfo serviceInfo, int errorCode) {
                Log.w(TAG, "resolve failed for " + serviceInfo.getServiceName() + ": " + errorCode);
                synchronized (NsdDiscovery.this) {
                    resolving = false;
                    drainResolveQueue();
                }
            }

            @Override public void onServiceResolved(NsdServiceInfo resolved) {
                String host = "";
                try {
                    if (resolved.getHost() != null) host = resolved.getHost().getHostAddress();
                } catch (Exception e) {
                    host = "";
                }
                String peerId = txt(resolved, TXT_ID);
                if (peerId == null || peerId.isEmpty()) peerId = resolved.getServiceName();
                String name = txt(resolved, TXT_NAME);
                if (name == null || name.isEmpty()) name = resolved.getServiceName();
                if (host != null && !host.isEmpty()) {
                    serviceToPeer.put(resolved.getServiceName(), peerId);
                    listener.onPeer(peerId, name, host, resolved.getPort());
                }
                synchronized (NsdDiscovery.this) {
                    resolving = false;
                    drainResolveQueue();
                }
            }
        });
    }

    private static String txt(NsdServiceInfo info, String key) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                byte[] raw = info.getAttributes().get(key);
                if (raw == null) return null;
                return new String(raw, "UTF-8");
            }
        } catch (Exception e) {
            Log.w(TAG, "bad TXT record", e);
        }
        return null;
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    private void state(String message) {
        try {
            listener.onState(message);
        } catch (Exception e) {
            Log.w(TAG, "state listener threw", e);
        }
    }

    private void acquireMulticastLock() {
        if (multicastLock != null && multicastLock.isHeld()) return;
        try {
            WifiManager wifi = (WifiManager) context.getApplicationContext()
                    .getSystemService(Context.WIFI_SERVICE);
            if (wifi == null) return;
            multicastLock = wifi.createMulticastLock("ghostmesh-nsd");
            multicastLock.setReferenceCounted(false);
            multicastLock.acquire();
        } catch (Exception e) {
            // Some devices refuse the lock; DNS-SD usually still works.
            Log.w(TAG, "multicast lock unavailable", e);
        }
    }

    private void releaseMulticastLock() {
        if (multicastLock == null) return;
        try {
            if (multicastLock.isHeld()) multicastLock.release();
        } catch (Exception ignored) {
        }
        multicastLock = null;
    }

    private static String sanitize(String value) {
        if (value == null || value.isEmpty()) return "ghost";
        String cleaned = value.replaceAll("[^A-Za-z0-9]", "");
        if (cleaned.length() > 20) cleaned = cleaned.substring(0, 20);
        return cleaned.isEmpty() ? "ghost" : cleaned;
    }
}

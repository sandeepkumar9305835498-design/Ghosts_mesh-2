package com.ghostmesh.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Binder;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Keeps nearby discovery (BLE + Wi-Fi Direct) running while the app is in the
 * background, so a message or call attempt can still be noticed when the phone
 * is in a pocket.
 *
 * This is a *foreground* service on purpose: Android only allows continuous
 * Bluetooth/Wi-Fi scanning from an app the user can see is running, and it
 * shows a small persistent notification for exactly that reason. There is no
 * server on the other end — the service only listens to radios.
 */
public class GhostMeshService extends Service
        implements BleMeshDiscovery.Listener, WifiDirectMesh.Listener {

    private static final String TAG = "GhostMeshService";

    public static final String ACTION_START = "com.ghostmesh.app.action.MESH_START";
    public static final String ACTION_STOP = "com.ghostmesh.app.action.MESH_STOP";

    private static final String CHANNEL_ID = "ghostmesh_mesh";
    private static final int NOTIFICATION_ID = 4711;

    /** Native peers keep being reported while the service runs. */
    public interface PeerListener {
        void onNativePeers(List<MeshPeer> peers);
    }

    /** Bound access for the activity: identity in, peer table out. */
    public class LocalBinder extends Binder {
        public GhostMeshService getService() {
            return GhostMeshService.this;
        }
    }

    private final IBinder binder = new LocalBinder();
    /** key -> peer, so a device seen on both transports is listed once. */
    private final Map<String, MeshPeer> peers = new LinkedHashMap<>();
    private final List<PeerListener> listeners = new CopyOnWriteArrayList<>();

    private BleMeshDiscovery ble;
    private WifiDirectMesh wifi;
    private String ghostId = "";
    private String displayName = "";
    private boolean running = false;

    // ------------------------------------------------------------- lifecycle
    public static void start(Context context) {
        Intent intent = new Intent(context, GhostMeshService.class).setAction(ACTION_START);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ContextCompat.startForegroundService(context, intent);
        } else {
            context.startService(intent);
        }
    }

    public static void stop(Context context) {
        Intent intent = new Intent(context, GhostMeshService.class).setAction(ACTION_STOP);
        context.startService(intent); // delivers ACTION_STOP, then stops itself
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        ble = new BleMeshDiscovery(this, this);
        wifi = new WifiDirectMesh(this, this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Must happen within a few seconds of startForegroundService().
        startForegroundCompat();
        String action = intent == null ? ACTION_START : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopDiscovery();
            stopSelf();
            return START_NOT_STICKY;
        }
        startDiscovery();
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return binder;
    }

    @Override
    public void onDestroy() {
        stopDiscovery();
        super.onDestroy();
    }

    private void startForegroundCompat() {
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // The type must match android:foregroundServiceType in the manifest.
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                getString(R.string.mesh_channel_name),
                NotificationManager.IMPORTANCE_LOW); // silent: no sound, no vibration
        channel.setDescription(getString(R.string.mesh_channel_description));
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pending = PendingIntent.getActivity(this, 0, open, flags);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(getString(R.string.mesh_notification_title))
                .setContentText(getString(R.string.mesh_notification_text))
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .setContentIntent(pending)
                .build();
    }

    // --------------------------------------------------------- discovery API
    public void startDiscovery() {
        if (running) return;
        running = true;
        try {
            ble.setGhostId(ghostId);
            ble.setDisplayName(displayName);
            ble.start();
        } catch (Exception e) {
            Log.w(TAG, "BLE discovery failed to start", e);
        }
        try {
            wifi.start();
        } catch (Exception e) {
            Log.w(TAG, "Wi-Fi Direct discovery failed to start", e);
        }
    }

    public void stopDiscovery() {
        running = false;
        try {
            ble.stop();
        } catch (Exception e) {
            Log.w(TAG, "BLE stop failed", e);
        }
        try {
            wifi.stop();
        } catch (Exception e) {
            Log.w(TAG, "Wi-Fi Direct stop failed", e);
        }
    }

    /** Ghost ID (e.g. "Ghost-ABC123") and name advertised to nearby devices. */
    public void setIdentity(String ghostId, String displayName) {
        if (ghostId != null && !ghostId.isEmpty()) this.ghostId = ghostId;
        if (displayName != null && !displayName.isEmpty()) this.displayName = displayName;
        if (ble != null) {
            ble.setGhostId(this.ghostId);
            ble.setDisplayName(this.displayName);
        }
    }

    public void addPeerListener(PeerListener listener) {
        if (listener != null && !listeners.contains(listener)) listeners.add(listener);
    }

    public void removePeerListener(PeerListener listener) {
        listeners.remove(listener);
    }

    /** Current peers (a copy — safe to iterate from another thread). */
    public List<MeshPeer> snapshotPeers() {
        synchronized (peers) {
            return new ArrayList<>(peers.values());
        }
    }

    public void connectToPeer(String address, WifiDirectMesh.Listener resultListener) {
        wifi.connect(address, resultListener);
    }

    // ------------------------------------------------------- peer reporting
    private void recordPeer(MeshPeer peer) {
        if (peer == null) return;
        synchronized (peers) {
            peers.put(peer.key(), peer);
        }
        List<MeshPeer> snapshot = snapshotPeers();
        for (PeerListener listener : listeners) {
            try {
                listener.onNativePeers(snapshot);
            } catch (Exception e) {
                Log.w(TAG, "Peer listener failed", e);
            }
        }
    }

    // -------------------------------------------- BleMeshDiscovery.Listener
    @Override
    public void onPeer(MeshPeer peer) {
        recordPeer(peer);
    }

    @Override
    public void onStatus(String message) {
        Log.i(TAG, "BLE: " + message);
    }

    // ---------------------------------------------- WifiDirectMesh.Listener
    @Override
    public void onGroupFormed(android.net.wifi.p2p.WifiP2pInfo info) {
        Log.i(TAG, "Wi-Fi Direct group formed, owner=" + info.isGroupOwner + " host=" + info.groupOwnerAddress);
    }

    @Override
    public void onConnectResult(boolean success, String message) {
        Log.i(TAG, "Wi-Fi Direct connect: " + success + " " + message);
    }

    /** Exposed so the activity can report Wi-Fi Direct results to the web layer. */
    public Collection<String> peerKeys() {
        synchronized (peers) {
            return new ArrayList<>(peers.keySet());
        }
    }
}

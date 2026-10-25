package com.ghostmesh.app;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.util.Log;

import androidx.core.content.ContextCompat;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Bluetooth LE proximity discovery: finds other Ghost Mesh phones without
 * internet, a hotspot or a QR scan.
 *
 * Design:
 *  - every phone advertises a fixed Ghost Mesh service UUID plus its short
 *    Ghost ID in the manufacturer-specific data (kept short on purpose: a BLE
 *    advertisement payload is only 31 bytes);
 *  - every phone scans for that same service UUID, so discovery is mutual and
 *    works with no pairing, no bonding and no server;
 *  - only the discovery step is BLE. Chat/call data still travels over the
 *    existing WebRTC path (or Wi-Fi Direct once a group is formed), so nothing
 *    about the current messaging flow changes.
 *
 * Permissions (checked here, requested by MainActivity):
 *  - Android 12+ : BLUETOOTH_SCAN (with neverForLocation), BLUETOOTH_ADVERTISE
 *  - Android 11- : ACCESS_FINE_LOCATION (BLE scanning is location-gated there)
 */
public class BleMeshDiscovery {

    public interface Listener {
        void onPeer(MeshPeer peer);
        void onStatus(String message);
    }

    private static final String TAG = "GhostMeshBLE";

    /** Fixed service UUID every Ghost Mesh device advertises and looks for. */
    public static final UUID SERVICE_UUID = UUID.fromString("d9a5e5c0-1b1e-4a3f-9f4e-7c1a9b6d0e01");
    /** Arbitrary company id used for the manufacturer-specific payload. */
    private static final int COMPANY_ID = 0x0A9B;
    /**
     * A legacy BLE advertisement is only 31 bytes. Flags (3) + company id (2)
     * + length/type bytes (2) already use 7, so the readable identity has to
     * stay small. This used to be 8 bytes AND the 128-bit service UUID was
     * added on top, which pushed the packet over the limit — advertising then
     * failed with DATA_TOO_LARGE and no phone was ever discoverable.
     */
    private static final int MAX_SHORT_ID_BYTES = 6;
    /** 31 - flags - company id - AD type/length headers. */
    private static final int MAX_PAYLOAD_BYTES = 12;

    private final Context context;
    private final Listener listener;
    private final Handler retryHandler = new Handler(Looper.getMainLooper());
    private int scanFailures = 0;

    private BluetoothAdapter adapter;
    private BluetoothLeAdvertiser advertiser;
    private BluetoothLeScanner scanner;
    private String shortGhostId = "";
    private String displayName = "";
    private boolean advertising = false;
    private boolean scanning = false;

    public BleMeshDiscovery(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
    }

    // ------------------------------------------------------------- permissions
    private boolean hasScanPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return granted(Manifest.permission.BLUETOOTH_SCAN);
        }
        return granted(Manifest.permission.ACCESS_FINE_LOCATION);
    }

    private boolean hasAdvertisePermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return granted(Manifest.permission.BLUETOOTH_ADVERTISE);
        }
        return true; // normal permission on older releases
    }

    private boolean hasConnectPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return granted(Manifest.permission.BLUETOOTH_CONNECT);
        }
        return true;
    }

    private boolean granted(String permission) {
        return ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * On Android 12+ adapter.isEnabled() itself needs BLUETOOTH_CONNECT, so
     * calling it before the prompt is answered throws SecurityException. That
     * used to abort discovery on the very first tap; now a missing permission
     * simply means "assume the radio is on and let the permission check in
     * start() report the real problem".
     */
    public boolean isSupported() {
        BluetoothManager manager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
        adapter = (manager == null) ? null : manager.getAdapter();
        if (adapter == null) return false;
        try {
            return adapter.isEnabled();
        } catch (SecurityException e) {
            Log.i(TAG, "Radio state needs BLUETOOTH_CONNECT; assuming on until granted");
            return true;
        }
    }

    /** True when both radios are switched on (used by the diagnostics JSON). */
    public boolean isBluetoothEnabled() {
        BluetoothManager manager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter current = (manager == null) ? null : manager.getAdapter();
        if (current == null) return false;
        try {
            return current.isEnabled();
        } catch (SecurityException e) {
            return false;
        }
    }

    public boolean isAdvertising() { return advertising; }
    public boolean isScanning() { return scanning; }

    // ----------------------------------------------------------------- control
    /** Ghost ID (e.g. "Ghost-ABC123") advertised to nearby devices. */
    public void setGhostId(String ghostId) {
        String id = ghostId == null ? "" : ghostId;
        if (id.startsWith("Ghost-")) id = id.substring("Ghost-".length());
        byte[] bytes = id.getBytes(StandardCharsets.US_ASCII);
        if (bytes.length > MAX_SHORT_ID_BYTES) bytes = java.util.Arrays.copyOf(bytes, MAX_SHORT_ID_BYTES);
        String next = new String(bytes, StandardCharsets.US_ASCII);
        if (next.equals(shortGhostId)) return;
        this.shortGhostId = next;
        // The identity arrives a moment after the service starts; re-advertise
        // so nearby phones see the real Ghost ID instead of an empty payload.
        if (advertising) {
            stopAdvertising();
            retryHandler.postDelayed(this::startAdvertising, 300);
        }
    }

    public void setDisplayName(String name) {
        String next = name == null ? "" : name;
        if (next.equals(displayName)) return;
        this.displayName = next;
        if (advertising) {
            stopAdvertising();
            retryHandler.postDelayed(this::startAdvertising, 300);
        }
    }

    public void start() {
        if (!isSupported()) {
            listener.onStatus("Bluetooth is off or unavailable");
            return;
        }
        if (!hasAdvertisePermission() || !hasScanPermission()) {
            listener.onStatus("Bluetooth permission missing");
            return;
        }
        scanFailures = 0;
        startAdvertising();
        startScanning();
    }

    public void stop() {
        retryHandler.removeCallbacksAndMessages(null);
        scanFailures = 0;
        stopAdvertising();
        stopScanning();
    }

    // ------------------------------------------------------------- advertising
    private void startAdvertising() {
        if (advertising || adapter == null) return;
        advertiser = adapter.getBluetoothLeAdvertiser();
        if (advertiser == null) {
            listener.onStatus("This device cannot advertise over BLE");
            return;
        }
        AdvertiseSettings settings = new AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
                .setConnectable(false)
                .build();

        // Manufacturer data only. Adding the 128-bit service UUID as well made
        // the packet too big, which is why advertising silently failed before.
        // The scanner filters on COMPANY_ID in handleResult() instead.
        AdvertiseData.Builder data = new AdvertiseData.Builder()
                .setIncludeDeviceName(false)
                .addManufacturerData(COMPANY_ID, buildPayload());
        try {
            advertiser.startAdvertising(settings, data.build(), advertiseCallback);
        } catch (SecurityException e) {
            Log.w(TAG, "Advertising permission denied", e);
            listener.onStatus("Bluetooth advertising not permitted");
        }
    }

    /**
     * Short id + optional name, capped so the whole advertisement stays inside
     * the 31 byte BLE limit (flags + AD headers + company id + payload).
     */
    private byte[] buildPayload() {
        String payload = shortGhostId;
        if (!displayName.isEmpty()
                && !payload.isEmpty()
                && payload.length() + displayName.length() + 1 <= MAX_PAYLOAD_BYTES) {
            payload = payload + "|" + displayName;
        }
        byte[] bytes = payload.getBytes(StandardCharsets.US_ASCII);
        return bytes.length > MAX_PAYLOAD_BYTES
                ? java.util.Arrays.copyOf(bytes, MAX_PAYLOAD_BYTES)
                : bytes;
    }

    private final AdvertiseCallback advertiseCallback = new AdvertiseCallback() {
        @Override
        public void onStartSuccess(AdvertiseSettings settingsInEffect) {
            advertising = true;
            listener.onStatus("Bluetooth discovery on");
        }

        @Override
        public void onStartFailure(int errorCode) {
            advertising = false;
            Log.w(TAG, "Advertise failed: " + errorCode);
            listener.onStatus("Could not start Bluetooth discovery (" + errorCode + ")");
        }
    };

    private void stopAdvertising() {
        if (advertiser == null) return;
        try {
            advertiser.stopAdvertising(advertiseCallback);
        } catch (Exception e) {
            Log.w(TAG, "stopAdvertising failed", e);
        }
        advertising = false;
        advertiser = null;
    }

    // ---------------------------------------------------------------- scanning
    private void startScanning() {
        if (scanning || adapter == null) return;
        if (!hasScanPermission()) {
            listener.onStatus("Bluetooth scanning permission missing");
            return;
        }
        try {
            scanner = adapter.getBluetoothLeScanner();
        } catch (SecurityException e) {
            Log.w(TAG, "Scanner needs BLUETOOTH_SCAN", e);
            listener.onStatus("Bluetooth scanning not permitted");
            return;
        }
        if (scanner == null) {
            listener.onStatus("Bluetooth scanner unavailable");
            return;
        }
        // No service-UUID filter: a filtered scan silently matches nothing when
        // the other phone could not fit the UUID in its advertisement. We scan
        // broadly and drop every packet that is not ours in handleResult().
        List<ScanFilter> filters = new ArrayList<>();
        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .setReportDelay(0)
                .build();
        try {
            scanning = true;
            scanner.startScan(filters, settings, scanCallback);
            listener.onStatus("Scanning for nearby Ghost Mesh phones");
        } catch (SecurityException e) {
            scanning = false;
            Log.w(TAG, "Scan permission denied", e);
            listener.onStatus("Bluetooth scanning not permitted");
        } catch (IllegalStateException e) {
            // "Scan already started" / adapter turned off mid-call.
            Log.w(TAG, "Could not start BLE scan", e);
            listener.onStatus("Bluetooth scan could not start — turn Bluetooth off and on");
        }
    }

    /** Android only allows a handful of concurrent scans; retry a few times. */
    private void scheduleScanRetry() {
        if (scanFailures >= 4) return;
        scanFailures++;
        scanning = false;
        long delay = 3000L * scanFailures;
        Log.i(TAG, "BLE scan retry in " + (delay / 1000) + "s (attempt " + scanFailures + ")");
        retryHandler.postDelayed(this::startScanning, delay);
    }

    private void stopScanning() {
        if (scanner == null || !scanning) return;
        try {
            scanner.stopScan(scanCallback);
        } catch (Exception e) {
            Log.w(TAG, "stopScan failed", e);
        }
        scanning = false;
    }

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            handleResult(result);
        }

        @Override
        public void onBatchScanResults(List<ScanResult> results) {
            for (ScanResult result : results) handleResult(result);
        }

        @Override
        public void onScanFailed(int errorCode) {
            Log.w(TAG, "Scan failed: " + errorCode);
            if (errorCode == SCAN_FAILED_ALREADY_STARTED) {
                scanning = true;   // another scan of ours is already running
                return;
            }
            if (errorCode == SCAN_FAILED_FEATURE_UNSUPPORTED) {
                scanning = false;
                listener.onStatus("This phone cannot scan for Bluetooth LE devices");
                return;
            }
            // APP_REGISTRATION_FAILED (too many scan apps) and INTERNAL_ERROR
            // are transient — retry instead of giving up for the whole session.
            listener.onStatus("Bluetooth scan busy — retrying");
            scheduleScanRetry();
        }
    };

    private void handleResult(ScanResult result) {
        if (result == null || result.getDevice() == null) return;
        ScanRecord record = result.getScanRecord();
        if (record == null) return;
        byte[] payload = record.getManufacturerSpecificData(COMPANY_ID);
        // Not a Ghost Mesh advertisement — the unfiltered scan sees every BLE
        // device around, so everything else is dropped right here.
        if (payload == null) return;
        String text = new String(payload, StandardCharsets.US_ASCII);
        int sep = text.indexOf('|');
        String shortId = (sep >= 0) ? text.substring(0, sep) : text;
        String name = (sep >= 0) ? text.substring(sep + 1) : "";
        if (name.isEmpty() && record.getDeviceName() != null) name = record.getDeviceName();
        String ghostId = shortId.isEmpty() ? null : "Ghost-" + shortId;
        if (name.isEmpty() && adapter != null && hasConnectPermission()) {
            try {
                String deviceName = result.getDevice().getName();
                if (deviceName != null) name = deviceName;
            } catch (SecurityException ignored) {
                // name needs BLUETOOTH_CONNECT on 12+; not fatal
            }
        }
        listener.onPeer(new MeshPeer(ghostId, name, result.getDevice().getAddress(), result.getRssi(), "ble"));
    }
}

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
    private static final int MAX_SHORT_ID_BYTES = 8;

    private final Context context;
    private final Listener listener;

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

    public boolean isSupported() {
        BluetoothManager manager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
        adapter = (manager == null) ? null : manager.getAdapter();
        return adapter != null && adapter.isEnabled();
    }

    // ----------------------------------------------------------------- control
    /** Ghost ID (e.g. "Ghost-ABC123") advertised to nearby devices. */
    public void setGhostId(String ghostId) {
        String id = ghostId == null ? "" : ghostId;
        if (id.startsWith("Ghost-")) id = id.substring("Ghost-".length());
        byte[] bytes = id.getBytes(StandardCharsets.US_ASCII);
        if (bytes.length > MAX_SHORT_ID_BYTES) bytes = java.util.Arrays.copyOf(bytes, MAX_SHORT_ID_BYTES);
        this.shortGhostId = new String(bytes, StandardCharsets.US_ASCII);
    }

    public void setDisplayName(String name) {
        this.displayName = name == null ? "" : name;
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
        startAdvertising();
        startScanning();
    }

    public void stop() {
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

        AdvertiseData.Builder data = new AdvertiseData.Builder()
                .addServiceUuid(new ParcelUuid(SERVICE_UUID))
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
     * the 31 byte BLE limit (16 byte UUID + 2 byte company id + payload).
     */
    private byte[] buildPayload() {
        String payload = shortGhostId;
        if (!displayName.isEmpty() && shortGhostId.length() + displayName.length() + 1 <= 12) {
            payload = shortGhostId + "|" + displayName;
        }
        return payload.getBytes(StandardCharsets.US_ASCII);
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
    }

    // ---------------------------------------------------------------- scanning
    private void startScanning() {
        if (scanning || adapter == null) return;
        scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) {
            listener.onStatus("Bluetooth scanner unavailable");
            return;
        }
        List<ScanFilter> filters = new ArrayList<>();
        filters.add(new ScanFilter.Builder().setServiceUuid(new ParcelUuid(SERVICE_UUID)).build());
        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .setReportDelay(0)
                .build();
        try {
            scanner.startScan(filters, settings, scanCallback);
            scanning = true;
        } catch (SecurityException e) {
            Log.w(TAG, "Scan permission denied", e);
            listener.onStatus("Bluetooth scanning not permitted");
        }
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
            listener.onStatus("Bluetooth scan failed (" + errorCode + ")");
        }
    };

    private void handleResult(ScanResult result) {
        if (result == null || result.getDevice() == null) return;
        ScanRecord record = result.getScanRecord();
        String shortId = "";
        String name = "";
        if (record != null) {
            byte[] payload = record.getManufacturerSpecificData(COMPANY_ID);
            if (payload != null) {
                String text = new String(payload, StandardCharsets.US_ASCII);
                int sep = text.indexOf('|');
                shortId = (sep >= 0) ? text.substring(0, sep) : text;
                name = (sep >= 0) ? text.substring(sep + 1) : "";
            }
            if (name.isEmpty() && record.getDeviceName() != null) name = record.getDeviceName();
        }
        if (shortId.isEmpty()) {
            // Advertised our service but without a readable id — still worth
            // showing, addressed by its MAC.
            shortId = null;
        }
        String ghostId = (shortId == null || shortId.isEmpty()) ? null : "Ghost-" + shortId;
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

package com.ghostmesh.app;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * One nearby device found by the native transports (BLE or Wi-Fi Direct).
 *
 * The web layer receives these through the GhostNative bridge and merges them
 * into the existing "Online Nearby" / "Ghosts You Can Reach" lists, so a
 * Bluetooth-discovered phone shows up next to PeerJS-discovered ones.
 */
public class MeshPeer {

    /** Ghost ID when the peer advertised one, otherwise a stable local label. */
    public final String ghostId;
    /** Human readable device/ghost name, may be empty. */
    public final String name;
    /** Transport-specific address: BLE MAC, or Wi-Fi Direct device address. */
    public final String address;
    /** Signal strength in dBm (0 when unknown). */
    public final int rssi;
    /** "ble" or "wifi-direct". */
    public final String transport;
    public final long lastSeen;

    public MeshPeer(String ghostId, String name, String address, int rssi, String transport) {
        this.ghostId = ghostId;
        this.name = name == null ? "" : name;
        this.address = address == null ? "" : address;
        this.rssi = rssi;
        this.transport = transport;
        this.lastSeen = System.currentTimeMillis();
    }

    /** Stable identity for de-duplication inside the web layer's peer table. */
    public String key() {
        return (ghostId != null && !ghostId.isEmpty()) ? ghostId : transport + ":" + address;
    }

    public JSONObject toJson() throws JSONException {
        JSONObject json = new JSONObject();
        json.put("ghostId", key());
        json.put("name", name);
        json.put("address", address);
        json.put("rssi", rssi);
        json.put("transport", transport);
        json.put("lastSeen", lastSeen);
        return json;
    }

    @Override
    public String toString() {
        return "MeshPeer{" + key() + ", " + transport + ", rssi=" + rssi + "}";
    }
}

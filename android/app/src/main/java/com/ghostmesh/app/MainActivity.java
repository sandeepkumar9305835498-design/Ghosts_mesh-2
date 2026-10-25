package com.ghostmesh.app;

import android.Manifest;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.ConsoleMessage;
import android.webkit.GeolocationPermissions;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebBackForwardList;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.view.View;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.PickVisualMediaRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;

import com.google.android.gms.ads.AdError;
import com.google.android.gms.ads.AdListener;
import com.google.android.gms.ads.AdRequest;
import com.google.android.gms.ads.AdSize;
import com.google.android.gms.ads.AdView;
import com.google.android.gms.ads.FullScreenContentCallback;
import com.google.android.gms.ads.LoadAdError;
import com.google.android.gms.ads.MobileAds;
import com.google.android.gms.ads.initialization.AdapterStatus;
import com.google.android.gms.ads.interstitial.InterstitialAd;
import com.google.android.gms.ads.interstitial.InterstitialAdLoadCallback;
import com.google.android.gms.ads.rewarded.RewardedAd;
import com.google.android.gms.ads.rewarded.RewardedAdLoadCallback;

import org.json.JSONArray;
import org.json.JSONException;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Hosts the Ghost Mesh web app (index.html / script.js / style.css, packaged
 * into assets/www by the copyWebAssets Gradle task).
 *
 * Why WebViewAssetLoader and not file://
 * --------------------------------------
 * The app needs camera + microphone + geolocation (QR pairing, voice notes,
 * voice/video calls, radar map). Browsers only expose those APIs in a "secure
 * context", and file:// is not one — loading the page from a file silently
 * breaks scanning and calling. WebViewAssetLoader serves the same files from
 * https://appassets.androidplatform.net, a real secure origin, so every API
 * behaves exactly like it does in Chrome.
 */
public class MainActivity extends AppCompatActivity implements GhostMeshService.PeerListener {

    private static final String TAG = "GhostMeshWeb";

    /** Secure origin used by WebViewAssetLoader. */
    private static final String DOMAIN = "appassets.androidplatform.net";
    /** assets/www/index.html, served through the secure origin above. */
    private static final String START_URL = "https://" + DOMAIN + "/assets/www/index.html";
    /** Appended to the user agent so the page can tell it is inside the APK. */
    private static final String APP_USER_AGENT_SUFFIX = "GhostMeshAndroid/1.0";

    private WebView webView;
    private WebViewAssetLoader assetLoader;

    // ------------------------------------------------------------------
    // Native mesh: BLE proximity discovery + Wi-Fi Direct (see the plan)
    //
    // The web layer drives this through window.GhostNative; the service keeps
    // the radios scanning while the app is in the background, and every peer it
    // finds is pushed straight into the page's existing reach lists.
    // ------------------------------------------------------------------
    private GhostNativeBridge nativeBridge;
    private GhostMeshService meshService;
    private boolean meshBound = false;
    private String nativeGhostId = "";
    private String nativeDisplayName = "";

    // ------------------------------------------------------------------
    // AdMob
    //
    // Google does not allow AdMob units inside a WebView, so every ad in the
    // APK is a real native view behind window.Android (see AndroidBridge at the
    // bottom). script.js asks isNativeAdsAvailable() first and only falls back
    // to its own house ad when this class is not there.
    //
    // The app id (ca-app-pub-…~…) lives in AndroidManifest.xml as
    // com.google.android.gms.ads.APPLICATION_ID. Without that meta-data
    // MobileAds.initialize() silently never calls back and no ad ever loads.
    // ------------------------------------------------------------------
    /** Google's official test units: always fill, safe to ship in any build. */
    private static final String TEST_BANNER_UNIT_ID = "ca-app-pub-3940256099942544/6300978111";
    private static final String TEST_INTERSTITIAL_UNIT_ID = "ca-app-pub-3940256099942544/1033173712";
    private static final String TEST_REWARDED_UNIT_ID = "ca-app-pub-3940256099942544/5224354917";

    /**
     * Real unit ids from the AdMob console (Apps → Ghost Mesh → Ad units).
     * They look like ca-app-pub-8808521207954078/1234567890 (slash, not tilde).
     * While these are empty the official test units above are used, so the
     * ad slots still fill instead of staying blank.
     */
    private static final String BANNER_UNIT_ID = "";
    private static final String INTERSTITIAL_UNIT_ID = "";
    private static final String REWARDED_UNIT_ID = "";

    private static final long AD_RETRY_MIN_MS = 15_000L;
    private static final long AD_RETRY_MAX_MS = 120_000L;
    private static final int AD_MAX_ATTEMPTS = 8;

    private FrameLayout adContainer;
    private AdView adView;
    private RewardedAd rewardedAd;
    private InterstitialAd interstitialAd;
    private boolean adsStarted = false, adsInitialized = false, bannerAllowed = true, bannerLoaded = false;
    private boolean loadingRewarded = false, loadingInterstitial = false, pendingRewarded = false;
    private int bannerAttempts = 0, rewardedAttempts = 0, interstitialAttempts = 0;
    private final Handler adHandler = new Handler(Looper.getMainLooper());

    private final ServiceConnection meshConnection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder service) {
            meshService = ((GhostMeshService.LocalBinder) service).getService();
            meshBound = true;
            meshService.addPeerListener(MainActivity.this);
            meshService.setIdentity(nativeGhostId, nativeDisplayName);
            pushCurrentNativePeers();
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            meshBound = false;
            meshService = null;
        }
    };

    /**
     * Asks for the radio permissions if needed, then starts the service.
     *
     * Only the *discovery* permissions decide whether discovery may start:
     * notifications were part of the same batch before, so declining the
     * notification prompt (very common) left nearby discovery permanently off
     * even though Bluetooth and Wi-Fi had been allowed.
     */
    private final ActivityResultLauncher<String[]> meshPermissionLauncher =
            registerForActivityResult(new ActivityResultContracts.RequestMultiplePermissions(), result -> {
                if (missingEssentialMeshPermissions().length == 0) {
                    startMeshService();
                    return;
                }
                if (!anyPermissionCanStillBeAsked(essentialMeshPermissions())) {
                    pushNativeStatus("Nearby devices are blocked in Settings — tap to allow them");
                    showNearbyPermissionDialog();
                    return;
                }
                pushNativeStatus("Bluetooth / Wi-Fi Direct permission denied — QR pairing still works");
            });

    /** The permissions discovery genuinely needs (notifications are optional). */
    private String[] essentialMeshPermissions() {
        List<String> needed = new ArrayList<>();
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) {
            needed.add(Manifest.permission.BLUETOOTH_SCAN);
            needed.add(Manifest.permission.BLUETOOTH_CONNECT);
            needed.add(Manifest.permission.BLUETOOTH_ADVERTISE);
        } else {
            // BLE scanning and Wi-Fi Direct discovery are location-gated before S.
            needed.add(Manifest.permission.ACCESS_FINE_LOCATION);
            needed.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        }
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            needed.add(Manifest.permission.NEARBY_WIFI_DEVICES);
        }
        return needed.toArray(new String[0]);
    }

    /** Nice to have: without it the discovery notification is hidden. */
    private String[] optionalMeshPermissions() {
        List<String> optional = new ArrayList<>();
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU
                && !hasPermission(Manifest.permission.POST_NOTIFICATIONS)) {
            optional.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        return optional.toArray(new String[0]);
    }

    private String[] missingEssentialMeshPermissions() {
        List<String> missing = new ArrayList<>();
        for (String permission : essentialMeshPermissions()) {
            if (!hasPermission(permission)) missing.add(permission);
        }
        return missing.toArray(new String[0]);
    }

    /** True while Android would still show a system prompt for these. */
    private boolean anyPermissionCanStillBeAsked(String[] permissions) {
        for (String permission : permissions) {
            if (androidx.core.app.ActivityCompat.shouldShowRequestPermissionRationale(this, permission)) {
                return true;
            }
        }
        return false;
    }

    private android.content.SharedPreferences nativePrefs() {
        return getSharedPreferences("gm_native", MODE_PRIVATE);
    }

    /** Called from the GhostNative bridge (always on the UI thread). */
    public void requestNativeMeshStart() {
        if (!isNativeMeshSupported()) {
            pushNativeStatus("This device has no Bluetooth LE or Wi-Fi Direct");
            return;
        }
        String[] missing = missingEssentialMeshPermissions();
        if (missing.length == 0) {
            nativePrefs().edit().putBoolean("mesh_enabled", true).apply();
            startMeshService();
            return;
        }
        // First ever tap: ask. After a "Don't allow", Android stops showing the
        // prompt, so send the person to Settings instead of doing nothing.
        boolean askedBefore = nativePrefs().getBoolean("mesh_perm_asked", false);
        if (askedBefore && !anyPermissionCanStillBeAsked(essentialMeshPermissions())) {
            pushNativeStatus("Nearby devices are blocked in Settings — tap to allow them");
            showNearbyPermissionDialog();
            return;
        }
        nativePrefs().edit().putBoolean("mesh_perm_asked", true).apply();
        nativePrefs().edit().putBoolean("mesh_enabled", true).apply();
        List<String> request = new ArrayList<>();
        for (String permission : missing) request.add(permission);
        for (String permission : optionalMeshPermissions()) request.add(permission);
        meshPermissionLauncher.launch(request.toArray(new String[0]));
    }

    /** Explains where to fix a permanently denied permission. */
    private void showNearbyPermissionDialog() {
        new AlertDialog.Builder(this)
                .setTitle(R.string.mesh_permission_title)
                .setMessage(R.string.mesh_permission_message)
                .setPositiveButton(R.string.mesh_open_settings, (dialog, which) -> openAppSettings())
                .setNegativeButton(android.R.string.cancel, null)
                .show();
    }

    public void openAppSettings() {
        try {
            Intent intent = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception e) {
            Log.w(TAG, "Could not open app settings", e);
        }
    }

    /** Bluetooth radio state, permission-safe. */
    public boolean isBluetoothEnabled() {
        android.bluetooth.BluetoothManager manager =
                (android.bluetooth.BluetoothManager) getSystemService(Context.BLUETOOTH_SERVICE);
        android.bluetooth.BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
        if (adapter == null) return false;
        try {
            return adapter.isEnabled();
        } catch (SecurityException e) {
            return false;
        }
    }

    /** Wi-Fi state: Wi-Fi Direct discovery needs the Wi-Fi radio on. */
    public boolean isWifiEnabled() {
        try {
            android.net.wifi.WifiManager wifi =
                    (android.net.wifi.WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            return wifi != null && wifi.isWifiEnabled();
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Everything that can make the nearby list empty, as JSON —
     * window.gmMeshDiag() in the WebView console prints it.
     */
    public String nativeMeshDiagnostics() {
        try {
            org.json.JSONObject permissions = new org.json.JSONObject();
            for (String permission : essentialMeshPermissions()) {
                permissions.put(permission.substring(permission.lastIndexOf('.') + 1), hasPermission(permission));
            }
            org.json.JSONObject json = new org.json.JSONObject()
                    .put("platform", "android")
                    .put("supported", isNativeMeshSupported())
                    .put("bluetoothEnabled", isBluetoothEnabled())
                    .put("wifiEnabled", isWifiEnabled())
                    .put("serviceRunning", meshBound && meshService != null)
                    .put("peerCount", meshService == null ? 0 : meshService.snapshotPeers().size())
                    .put("permissions", permissions);
            if (meshService != null) {
                json.put("bleAdvertising", meshService.isBleAdvertising())
                        .put("bleScanning", meshService.isBleScanning())
                        .put("wifiDiscovering", meshService.isWifiDiscovering());
            }
            return json.toString();
        } catch (Throwable t) {
            return "{\"error\":\"diagnostics failed\"}";
        }
    }

    private void startMeshService() {
        try {
            if (!meshBound) {
                bindService(new Intent(this, GhostMeshService.class), meshConnection, Context.BIND_AUTO_CREATE);
                meshBound = true;
            }
            GhostMeshService.start(this);
            // The service may already be up (second call): push the identity
            // straight in so advertised packets carry the real Ghost ID.
            if (meshService != null) meshService.setIdentity(nativeGhostId, nativeDisplayName);
            if (!isBluetoothEnabled()) pushNativeStatus("Turn Bluetooth on to see nearby Ghosts");
            else if (!isWifiEnabled()) pushNativeStatus("Turn Wi-Fi on for Wi-Fi Direct discovery");
            else pushNativeStatus("Looking for nearby Ghosts over Bluetooth + Wi-Fi Direct");
        } catch (Exception e) {
            Log.w(TAG, "Could not start the mesh service", e);
            pushNativeStatus("Could not start nearby discovery");
        }
    }

    /** Called from the GhostNative bridge (always on the UI thread). */
    public void requestNativeMeshStop() {
        nativePrefs().edit().putBoolean("mesh_enabled", false).apply();
        try {
            GhostMeshService.stop(this);
        } catch (Exception e) {
            Log.w(TAG, "Could not stop the mesh service", e);
        }
        if (meshService != null) meshService.removePeerListener(this);
        if (meshBound) {
            try {
                unbindService(meshConnection);
            } catch (IllegalArgumentException ignored) {
                // already unbound
            }
            meshBound = false;
        }
        meshService = null;
        pushNativeStatus("Nearby discovery stopped");
    }

    public boolean isNativeMeshSupported() {
        android.bluetooth.BluetoothManager bluetooth =
                (android.bluetooth.BluetoothManager) getSystemService(Context.BLUETOOTH_SERVICE);
        boolean hasBle = bluetooth != null && bluetooth.getAdapter() != null;
        boolean hasWifiDirect = getSystemService(Context.WIFI_P2P_SERVICE) != null;
        return hasBle || hasWifiDirect;
    }

    public void setNativeIdentity(String ghostId, String displayName) {
        if (ghostId != null && !ghostId.isEmpty()) nativeGhostId = ghostId;
        if (displayName != null && !displayName.isEmpty()) nativeDisplayName = displayName;
        if (meshService != null) meshService.setIdentity(nativeGhostId, nativeDisplayName);
    }

    public void connectNativePeer(String address) {
        if (meshService == null) {
            pushNativeStatus("Start nearby discovery first");
            return;
        }
        meshService.connectToPeer(address, new WifiDirectMesh.Listener() {
            @Override public void onPeer(MeshPeer peer) { /* discovery-only listener */ }
            @Override public void onStatus(String message) { Log.i(TAG, "Wi-Fi Direct: " + message); }
            @Override public void onGroupFormed(android.net.wifi.p2p.WifiP2pInfo info) { pushNativeStatus("Wi-Fi Direct group ready"); }
            @Override public void onConnectResult(boolean success, String message) { pushNativeStatus(message); }
        });
    }

    public void pushCurrentNativePeers() {
        List<MeshPeer> peers = (meshService == null) ? new ArrayList<>() : meshService.snapshotPeers();
        onNativePeers(peers);
    }

    public String nativePeersJson() {
        List<MeshPeer> peers = (meshService == null) ? new ArrayList<>() : meshService.snapshotPeers();
        JSONArray array = new JSONArray();
        for (MeshPeer peer : peers) {
            try {
                array.put(peer.toJson());
            } catch (JSONException e) {
                Log.w(TAG, "Could not serialise peer", e);
            }
        }
        return array.toString();
    }

    /** GhostMeshService.PeerListener — peers arrive on a worker thread. */
    @Override
    public void onNativePeers(List<MeshPeer> peers) {
        runOnUiThread(() -> {
            if (webView == null) return;
            JSONArray array = new JSONArray();
            for (MeshPeer peer : peers) {
                try {
                    array.put(peer.toJson());
                } catch (JSONException e) {
                    Log.w(TAG, "Could not serialise peer", e);
                }
            }
            // gmApplyNativePeers() re-renders both reach lists in script.js.
            webView.evaluateJavascript(
                    "window.gmApplyNativePeers && window.gmApplyNativePeers(" + array + ");", null);
        });
    }

    /** Small status line for the page (it shows it as the app's own toast). */
    private void pushNativeStatus(String message) {
        if (webView == null || message == null) return;
        webView.evaluateJavascript(
                "window.gmApplyNativeStatus && window.gmApplyNativeStatus(" + org.json.JSONObject.quote(message) + ");", null);
    }

    /** Runs a task on the UI thread, no matter which thread called it. */
    public void postToUi(Runnable task) {
        runOnUiThread(task);
    }



    /** Set while a JS permission request (camera/mic) waits for the user's answer. */
    private PermissionRequest pendingWebPermissionRequest;
    /** Set while the system file picker is open for an <input type="file">. */
    private ValueCallback<Uri[]> pendingFileChooserCallback;

    private final ActivityResultLauncher<String[]> permissionLauncher =
            registerForActivityResult(new ActivityResultContracts.RequestMultiplePermissions(),
                    result -> resolvePendingWebPermissionRequest());

    private final ActivityResultLauncher<Intent> fileChooserLauncher =
            registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
                if (pendingFileChooserCallback == null) return;
                pendingFileChooserCallback.onReceiveValue(
                        WebChromeClient.FileChooserParams.parseResult(result.getResultCode(), result.getData()));
                pendingFileChooserCallback = null;
            });

    /**
     * Android Photo Picker for <input type="file" accept="image/*">.
     *
     * createIntent() opens ACTION_GET_CONTENT, which on many OEM builds shows a
     * documents browser that asks the user to grant access to whole folders.
     * The Photo Picker (API 33+, with the system/Google Play fallback below it)
     * hands back only the single item the user tapped, so the app never gets
     * read access to the gallery — nothing to over-request, nothing to revoke.
     */
    private final ActivityResultLauncher<PickVisualMediaRequest> photoPickerLauncher =
            registerForActivityResult(new ActivityResultContracts.PickVisualMedia(), uri -> {
                if (pendingFileChooserCallback == null) return;
                pendingFileChooserCallback.onReceiveValue(uri == null ? null : new Uri[]{uri});
                pendingFileChooserCallback = null;
            });

    private final ActivityResultLauncher<PickVisualMediaRequest> photoPickerMultiLauncher =
            registerForActivityResult(new ActivityResultContracts.PickMultipleVisualMedia(10), uris -> {
                if (pendingFileChooserCallback == null) return;
                pendingFileChooserCallback.onReceiveValue(
                        uris == null || uris.isEmpty() ? null : uris.toArray(new Uri[0]));
                pendingFileChooserCallback = null;
            });

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // The app puts a 12-word recovery phrase and private chats on screen.
        // FLAG_SECURE blocks screenshots and screen recording, and keeps the
        // content out of the recent-apps thumbnail. Without it any other app
        // with screen-capture access could read the phrase off the display.
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE,
                WindowManager.LayoutParams.FLAG_SECURE);
        setContentView(R.layout.activity_main);

        assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(DOMAIN)
                // "/assets/www/index.html" -> assets/www/index.html
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        applySystemBarInsets();

        // Banner slot lives under the WebView; initAds() starts MobileAds and
        // requests the first banner as soon as the SDK is ready.
        initAds();

        webView = findViewById(R.id.webview);
        configureWebView();
        setupBackHandling();

        // window.GhostNative — the only native surface the page can reach.
        nativeBridge = new GhostNativeBridge(this);
        webView.addJavascriptInterface(nativeBridge, "GhostNative");
        // window.Android — the AdMob bridge script.js already calls.
        webView.addJavascriptInterface(new AndroidBridge(), "Android");

        if (savedInstanceState == null) {
            webView.loadUrl(START_URL);
        } else {
            // Restore the page after the process was recreated. If there is no
            // usable history (restore failed), fall back to a normal load so the
            // app can never come back to a blank screen.
            WebBackForwardList restored = webView.restoreState(savedInstanceState);
            if (restored == null || restored.getSize() == 0) {
                webView.loadUrl(START_URL);
            }
        }
    }

    /**
     * Apps targeting Android 15+ always draw edge to edge, so the WebView would
     * otherwise sit underneath the status and navigation bars. Pad the root
     * view with the system-bar insets instead; the keyboard is handled by the
     * web app's own visualViewport logic.
     */
    private void applySystemBarInsets() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.setAppearanceLightStatusBars(false);
        controller.setAppearanceLightNavigationBars(false);

        View root = findViewById(R.id.root);
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
    }

    // ------------------------------------------------------------------
    // WebView configuration
    // ------------------------------------------------------------------
    private void configureWebView() {
        WebSettings settings = webView.getSettings();

        // The app is a JavaScript app: nothing works without these two.
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);

        // Voice notes / call audio must be allowed to start without an extra tap.
        settings.setMediaPlaybackRequiresUserGesture(false);

        // Radar map + "share live location".
        settings.setGeolocationEnabled(true);

        // Match the mobile viewport in index.html.
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);

        // Files are served by the asset loader over https, so the WebView never
        // needs direct filesystem access — keep it off for safety.
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);

        // Required for window.open() (the app opens Google Maps links that way),
        // which is routed to the system browser in onCreateWindow below.
        settings.setSupportMultipleWindows(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);

        // Lets the page detect the native shell (service worker is skipped inside
        // the APK so a web update can never be masked by a stale cache).
        settings.setUserAgentString(settings.getUserAgentString() + " " + APP_USER_AGENT_SUFFIX);

        if (BuildConfig.DEBUG) {
            // chrome://inspect on the development machine shows the page console.
            WebView.setWebContentsDebuggingEnabled(true);
        }

        webView.setBackgroundColor(0xFF0D0B14);
        webView.setOverScrollMode(WebView.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);

        webView.setWebViewClient(new WebViewClientCompat() {
            @Nullable
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                // Serve everything from the APK (no network round trip, no file://).
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(@NonNull WebView view, @NonNull WebResourceRequest request) {
                Uri url = request.getUrl();
                if (DOMAIN.equals(url.getHost())) return false; // in-app page/asset
                openExternally(url);                            // e.g. Google Maps
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // Fired by getUserMedia(); must be answered or camera/mic stay blocked.
                runOnUiThread(() -> handleWebPermissionRequest(request));
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                boolean granted = hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                        || hasPermission(Manifest.permission.ACCESS_COARSE_LOCATION);
                callback.invoke(origin, granted, false);
                if (!granted) {
                    permissionLauncher.launch(new String[]{
                            Manifest.permission.ACCESS_FINE_LOCATION,
                            Manifest.permission.ACCESS_COARSE_LOCATION});
                }
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                // Photo/video/document attachments and the profile picture all use
                // <input type="file">, which does nothing without this hook.
                if (pendingFileChooserCallback != null) {
                    pendingFileChooserCallback.onReceiveValue(null);
                }
                pendingFileChooserCallback = callback;
                // Images only (profile picture, photo attachment) and no camera
                // capture → the Photo Picker can answer this with a scoped URI.
                String[] accept = params.getAcceptTypes();
                boolean imagesOnly = accept != null && accept.length > 0;
                if (accept != null) {
                    for (String type : accept) {
                        if (type == null || !type.contains("image")) { imagesOnly = false; break; }
                    }
                }
                try {
                    if (imagesOnly && !params.isCaptureEnabled()) {
                        boolean multiple = params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE;
                        PickVisualMediaRequest request = new PickVisualMediaRequest.Builder()
                                .setMediaType(ActivityResultContracts.PickVisualMedia.ImageOnly)
                                .build();
                        if (multiple) photoPickerMultiLauncher.launch(request);
                        else photoPickerLauncher.launch(request);
                        return true;
                    }
                    fileChooserLauncher.launch(params.createIntent());
                    return true;
                } catch (Exception e) {
                    Log.w(TAG, "No file picker available", e);
                    pendingFileChooserCallback = null;
                    Toast.makeText(MainActivity.this, R.string.file_picker_unavailable, Toast.LENGTH_SHORT).show();
                    return false;
                }
            }

            // The app uses alert()/confirm()/prompt(); a bare WebView answers them
            // automatically (confirm -> false, prompt -> null), which looked like
            // "logout / clear chat / paste code buttons do nothing".
            @Override
            public boolean onJsAlert(WebView view, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle(R.string.app_name)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok, (dialog, which) -> result.confirm())
                        .setOnCancelListener(dialog -> result.cancel())
                        .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle(R.string.app_name)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok, (dialog, which) -> result.confirm())
                        .setNegativeButton(android.R.string.cancel, (dialog, which) -> result.cancel())
                        .setOnCancelListener(dialog -> result.cancel())
                        .show();
                return true;
            }

            @Override
            public boolean onJsPrompt(WebView view, String url, String message,
                                      String defaultValue, final JsPromptResult result) {
                final EditText input = new EditText(MainActivity.this);
                input.setSingleLine(false);
                input.setText(defaultValue == null ? "" : defaultValue);
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle(R.string.app_name)
                        .setMessage(message)
                        .setView(input)
                        .setPositiveButton(android.R.string.ok,
                                (dialog, which) -> result.confirm(input.getText().toString()))
                        .setNegativeButton(android.R.string.cancel, (dialog, which) -> result.cancel())
                        .setOnCancelListener(dialog -> result.cancel())
                        .show();
                return true;
            }

            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                // window.open(...) from the page: hand that URL to the system
                // browser instead of spawning a second WebView.
                WebView popupTransport = new WebView(MainActivity.this);
                popupTransport.setWebViewClient(new WebViewClientCompat() {
                    @Override
                    public boolean shouldOverrideUrlLoading(@NonNull WebView v, @NonNull WebResourceRequest request) {
                        openExternally(request.getUrl());
                        v.destroy();
                        return true;
                    }
                });
                ((WebView.WebViewTransport) resultMsg.obj).setWebView(popupTransport);
                resultMsg.sendToTarget();
                return true;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
                // Visible in Android Studio's Logcat under the "GhostMeshWeb" tag.
                Log.d(TAG, consoleMessage.message() + " ("
                        + consoleMessage.sourceId() + ":" + consoleMessage.lineNumber() + ")");
                return true;
            }
        });
    }

    // ------------------------------------------------------------------
    // AdMob
    // ------------------------------------------------------------------
    private String bannerUnitId() { return pickUnit(BANNER_UNIT_ID, TEST_BANNER_UNIT_ID); }
    private String interstitialUnitId() { return pickUnit(INTERSTITIAL_UNIT_ID, TEST_INTERSTITIAL_UNIT_ID); }
    private String rewardedUnitId() { return pickUnit(REWARDED_UNIT_ID, TEST_REWARDED_UNIT_ID); }

    /** Real unit when one is configured, otherwise Google's test unit. */
    private String pickUnit(String real, String test) {
        return (real == null || real.trim().isEmpty()) ? test : real.trim();
    }

    private void initAds() {
        if (adContainer == null) adContainer = findViewById(R.id.ad_container);
        if (adsStarted) return;
        adsStarted = true;
        if (!adMobAppIdConfigured()) {
            Log.e(TAG, "AdMob APPLICATION_ID meta-data is missing/wrong in AndroidManifest.xml — ads disabled");
            return;
        }
        Log.i(TAG, "AdMob units → banner=" + bannerUnitId()
                + " rewarded=" + rewardedUnitId()
                + " interstitial=" + interstitialUnitId());
        try {
            MobileAds.initialize(this, initializationStatus -> {
                adsInitialized = true;
                for (Map.Entry<String, AdapterStatus> entry
                        : initializationStatus.getAdapterStatusMap().entrySet()) {
                    Log.i(TAG, "AdMob adapter " + entry.getKey() + " = "
                            + entry.getValue().getInitializationState()
                            + " " + entry.getValue().getDescription());
                }
                loadBanner();
                loadRewarded();
                loadInterstitial();
            });
        } catch (Throwable t) {
            Log.e(TAG, "AdMob could not initialise — check the APPLICATION_ID meta-data", t);
        }
    }

    /** Reads the AdMob app id from the manifest, the way the SDK does. */
    private boolean adMobAppIdConfigured() {
        try {
            ApplicationInfo info = getPackageManager()
                    .getApplicationInfo(getPackageName(), PackageManager.GET_META_DATA);
            String id = info.metaData == null ? null
                    : info.metaData.getString("com.google.android.gms.ads.APPLICATION_ID");
            boolean looksRight = id != null && id.startsWith("ca-app-pub-") && id.contains("~");
            if (!looksRight) Log.e(TAG, "Bad AdMob app id: " + id);
            return looksRight;
        } catch (Throwable t) {
            Log.e(TAG, "Could not read the AdMob app id", t);
            return false;
        }
    }

    /** 15s, 30s, 60s, 120s, 120s … */
    private long adRetryDelay(int attempts) {
        long delay = AD_RETRY_MIN_MS * (1L << Math.min(Math.max(attempts - 1, 0), 4));
        return Math.min(AD_RETRY_MAX_MS, delay);
    }

    /** Runs JS in the page, ignoring a page that is not ready yet. */
    private void jsCallback(String script) {
        if (webView == null) return;
        runOnUiThread(() -> {
            if (webView == null) return;
            try {
                webView.evaluateJavascript(script, null);
            } catch (Throwable t) {
                Log.w(TAG, "JS callback failed: " + script, t);
            }
        });
    }

    private void loadBanner() {
        if (adContainer == null) {
            Log.w(TAG, "Banner skipped: activity_main.xml has no @+id/ad_container");
            return;
        }
        if (!adsInitialized) return;
        if (bannerAttempts >= AD_MAX_ATTEMPTS) {
            Log.w(TAG, "Banner gave up after " + bannerAttempts + " attempts");
            return;
        }
        bannerAttempts++;
        try {
            if (adView != null) {
                adContainer.removeAllViews();
                adView.destroy();
                adView = null;
            }
            bannerLoaded = false;
            adView = new AdView(this);
            adView.setAdUnitId(bannerUnitId());
            adView.setAdSize(AdSize.BANNER);
            adView.setAdListener(new AdListener() {
                @Override
                public void onAdLoaded() {
                    bannerAttempts = 0;
                    bannerLoaded = true;
                    Log.i(TAG, "Banner loaded");
                    if (adContainer != null && bannerAllowed) adContainer.setVisibility(View.VISIBLE);
                }

                @Override
                public void onAdFailedToLoad(@NonNull LoadAdError adError) {
                    // 0 internal, 1 invalid request, 2 network, 3 no fill,
                    // 8 invalid ad unit id — 3 is normal for a brand-new app.
                    Log.w(TAG, "Banner failed [" + adError.getCode() + "/" + adError.getDomain()
                            + "]: " + adError.getMessage());
                    bannerLoaded = false;
                    if (adContainer != null) adContainer.setVisibility(View.GONE);
                    long delay = adRetryDelay(bannerAttempts);
                    adHandler.postDelayed(MainActivity.this::loadBanner, delay);
                }
            });
            adContainer.removeAllViews();
            adContainer.addView(adView);
            adView.loadAd(new AdRequest.Builder().build());
        } catch (Throwable t) {
            Log.w(TAG, "Banner setup failed", t);
        }
    }

    private void loadRewarded() {
        if (!adsInitialized || rewardedAd != null || loadingRewarded) return;
        if (rewardedAttempts >= AD_MAX_ATTEMPTS) {
            Log.w(TAG, "Rewarded gave up after " + rewardedAttempts + " attempts");
            return;
        }
        rewardedAttempts++;
        loadingRewarded = true;
        try {
            RewardedAd.load(this, rewardedUnitId(), new AdRequest.Builder().build(),
                    new RewardedAdLoadCallback() {
                        @Override
                        public void onAdLoaded(@NonNull RewardedAd ad) {
                            loadingRewarded = false;
                            rewardedAttempts = 0;
                            rewardedAd = ad;
                            Log.i(TAG, "Rewarded loaded");
                            ad.setFullScreenContentCallback(new FullScreenContentCallback() {
                                @Override
                                public void onAdShowedFullScreenContent() {
                                    Log.i(TAG, "Rewarded showing");
                                    setBannerVisible(false);
                                }

                                @Override
                                public void onAdDismissedFullScreenContent() {
                                    rewardedAd = null;
                                    setBannerVisible(true);
                                    jsCallback("window.gmOnAdClosed && window.gmOnAdClosed('rewarded')");
                                    loadRewarded();
                                }

                                @Override
                                public void onAdFailedToShowFullScreenContent(@NonNull AdError adError) {
                                    Log.w(TAG, "Rewarded show failed: " + adError.getMessage());
                                    rewardedAd = null;
                                    pendingRewarded = false;
                                    setBannerVisible(true);
                                    jsCallback("window.gmOnAdFailed && window.gmOnAdFailed()");
                                    loadRewarded();
                                }
                            });
                            if (pendingRewarded) {
                                pendingRewarded = false;
                                showRewardedAd();
                            }
                        }

                        @Override
                        public void onAdFailedToLoad(@NonNull LoadAdError adError) {
                            loadingRewarded = false;
                            rewardedAd = null;
                            Log.w(TAG, "Rewarded failed [" + adError.getCode() + "/" + adError.getDomain()
                                    + "]: " + adError.getMessage());
                            if (pendingRewarded) {
                                pendingRewarded = false;
                                jsCallback("window.gmOnAdFailed && window.gmOnAdFailed()");
                            }
                            long delay = adRetryDelay(rewardedAttempts);
                            adHandler.postDelayed(MainActivity.this::loadRewarded, delay);
                        }
                    });
        } catch (Throwable t) {
            loadingRewarded = false;
            Log.w(TAG, "Rewarded load crashed", t);
        }
    }

    private void loadInterstitial() {
        if (!adsInitialized || interstitialAd != null || loadingInterstitial) return;
        if (interstitialAttempts >= AD_MAX_ATTEMPTS) return;
        interstitialAttempts++;
        loadingInterstitial = true;
        try {
            InterstitialAd.load(this, interstitialUnitId(), new AdRequest.Builder().build(),
                    new InterstitialAdLoadCallback() {
                        @Override
                        public void onAdLoaded(@NonNull InterstitialAd ad) {
                            loadingInterstitial = false;
                            interstitialAttempts = 0;
                            interstitialAd = ad;
                            Log.i(TAG, "Interstitial loaded");
                            ad.setFullScreenContentCallback(new FullScreenContentCallback() {
                                @Override
                                public void onAdDismissedFullScreenContent() {
                                    interstitialAd = null;
                                    setBannerVisible(true);
                                    loadInterstitial();
                                }

                                @Override
                                public void onAdFailedToShowFullScreenContent(@NonNull AdError adError) {
                                    Log.w(TAG, "Interstitial show failed: " + adError.getMessage());
                                    interstitialAd = null;
                                    setBannerVisible(true);
                                    loadInterstitial();
                                }
                            });
                        }

                        @Override
                        public void onAdFailedToLoad(@NonNull LoadAdError adError) {
                            loadingInterstitial = false;
                            interstitialAd = null;
                            Log.w(TAG, "Interstitial failed [" + adError.getCode() + "/"
                                    + adError.getDomain() + "]: " + adError.getMessage());
                            adHandler.postDelayed(MainActivity.this::loadInterstitial,
                                    adRetryDelay(interstitialAttempts));
                        }
                    });
        } catch (Throwable t) {
            loadingInterstitial = false;
            Log.w(TAG, "Interstitial load crashed", t);
        }
    }

    /** Called on the UI thread from AndroidBridge. */
    private void showRewardedAd() {
        if (!adsStarted) initAds();
        if (!adsInitialized) {
            pendingRewarded = true;
            jsCallback("window.gmOnAdLoading && window.gmOnAdLoading()");
            return;
        }
        RewardedAd ad = rewardedAd;
        if (ad == null) {
            pendingRewarded = true;
            jsCallback("window.gmOnAdLoading && window.gmOnAdLoading()");
            loadRewarded();
            return;
        }
        rewardedAd = null;
        ad.show(this, item -> {
            // The page pays the reward itself in gmOnRewardedAdCompleted().
            int amount = item == null ? 0 : item.getAmount();
            jsCallback("(function(){var a=" + amount + ";"
                    + "if (typeof window.gmOnRewardedAdCompleted === 'function'){window.gmOnRewardedAdCompleted(a);return;}"
                    + "if (typeof window.giveUserReward === 'function'){window.giveUserReward(a);return;}"
                    + "})();");
        });
    }

    /** Called on the UI thread from AndroidBridge. */
    private void showInterstitialAd() {
        InterstitialAd ad = interstitialAd;
        if (ad == null) {
            loadInterstitial();
            return;
        }
        interstitialAd = null;
        setBannerVisible(false);
        ad.show(this);
    }

    private void hideBanner() { setBannerVisible(false); }
    private void showBanner() { setBannerVisible(true); }

    /**
     * Store policy: no banner during a call or on top of a full-screen ad. The
     * page decides (gmSyncAdBanner) and calls this; the view only ever becomes
     * VISIBLE after a banner really loaded.
     */
    private void setBannerVisible(boolean visible) {
        bannerAllowed = visible;
        if (adContainer == null) return;
        runOnUiThread(() -> {
            if (adContainer == null) return;
            adContainer.setVisibility(visible && bannerLoaded ? View.VISIBLE : View.GONE);
        });
    }

    private String adStatusJson() {
        try {
            return new org.json.JSONObject()
                    .put("platform", "android")
                    .put("appIdOk", adMobAppIdConfigured())
                    .put("sdkInitialized", adsInitialized)
                    .put("bannerLoaded", bannerLoaded)
                    .put("bannerVisible", adContainer != null && adContainer.getVisibility() == View.VISIBLE)
                    .put("bannerAttempts", bannerAttempts)
                    .put("rewardedLoaded", rewardedAd != null)
                    .put("rewardedAttempts", rewardedAttempts)
                    .put("interstitialLoaded", interstitialAd != null)
                    .put("units", new org.json.JSONObject()
                            .put("banner", bannerUnitId())
                            .put("rewarded", rewardedUnitId())
                            .put("interstitial", interstitialUnitId()))
                    .toString();
        } catch (Throwable t) {
            return "{\"error\":\"ad status failed\"}";
        }
    }

    /**
     * window.Android — the only ad surface the page can reach. Every method
     * here is what script.js calls, so the names must not change.
     */
    public class AndroidBridge {

        @JavascriptInterface
        public boolean isNativeAdsAvailable() {
            return adMobAppIdConfigured();
        }

        @JavascriptInterface
        public String getAdUnits() {
            try {
                return new org.json.JSONObject()
                        .put("banner", bannerUnitId())
                        .put("rewarded", rewardedUnitId())
                        .put("interstitial", interstitialUnitId())
                        .put("testUnits", BANNER_UNIT_ID.trim().isEmpty())
                        .toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public String getAdStatus() { return adStatusJson(); }

        /** The page calls this once after load; safe to call repeatedly. */
        @JavascriptInterface
        public void loadAds() {
            runOnUiThread(() -> {
                initAds();
                // A page reload is a fresh chance: give up counters start over
                // so a banner that exhausted its retries comes back too.
                if (bannerAttempts >= AD_MAX_ATTEMPTS) bannerAttempts = 0;
                if (rewardedAttempts >= AD_MAX_ATTEMPTS) rewardedAttempts = 0;
                if (interstitialAttempts >= AD_MAX_ATTEMPTS) interstitialAttempts = 0;
                if (adsInitialized && !bannerLoaded) loadBanner();
                loadRewarded();
                loadInterstitial();
            });
        }

        @JavascriptInterface
        public void showRewardedAd() {
            runOnUiThread(MainActivity.this::showRewardedAd);
        }

        @JavascriptInterface
        public void showInterstitialAd() {
            runOnUiThread(MainActivity.this::showInterstitialAd);
        }

        @JavascriptInterface
        public void hideBanner() {
            runOnUiThread(MainActivity.this::hideBanner);
        }

        @JavascriptInterface
        public void showBanner() {
            runOnUiThread(MainActivity.this::showBanner);
        }

        @JavascriptInterface
        public void setBannerVisible(boolean visible) {
            runOnUiThread(() -> MainActivity.this.setBannerVisible(visible));
        }

        /** script.js asks for camera/mic this way before retrying a call. */
        @JavascriptInterface
        public void requestPermissions() {
            runOnUiThread(() -> {
                List<String> missing = new ArrayList<>();
                if (!hasPermission(Manifest.permission.CAMERA)) missing.add(Manifest.permission.CAMERA);
                if (!hasPermission(Manifest.permission.RECORD_AUDIO)) missing.add(Manifest.permission.RECORD_AUDIO);
                if (!missing.isEmpty()) permissionLauncher.launch(missing.toArray(new String[0]));
            });
        }

        @JavascriptInterface
        public void toast(String message) {
            if (message == null) return;
            runOnUiThread(() -> Toast.makeText(MainActivity.this, message, Toast.LENGTH_SHORT).show());
        }
    }

    // ------------------------------------------------------------------
    // Permissions
    // ------------------------------------------------------------------
    private void handleWebPermissionRequest(PermissionRequest request) {
        List<String> missing = new ArrayList<>();
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)
                    && !hasPermission(Manifest.permission.CAMERA)) {
                missing.add(Manifest.permission.CAMERA);
            } else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)
                    && !hasPermission(Manifest.permission.RECORD_AUDIO)) {
                missing.add(Manifest.permission.RECORD_AUDIO);
            }
        }

        if (missing.isEmpty()) {
            request.grant(request.getResources());
            return;
        }

        // Ask the user first, then answer the page's request in the callback.
        pendingWebPermissionRequest = request;
        permissionLauncher.launch(missing.toArray(new String[0]));
    }

    private void resolvePendingWebPermissionRequest() {
        PermissionRequest request = pendingWebPermissionRequest;
        if (request == null) return;
        pendingWebPermissionRequest = null;

        List<String> granted = new ArrayList<>();
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                if (hasPermission(Manifest.permission.CAMERA)) granted.add(resource);
            } else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                if (hasPermission(Manifest.permission.RECORD_AUDIO)) granted.add(resource);
            } else {
                granted.add(resource);
            }
        }

        if (granted.isEmpty()) {
            request.deny();   // the page shows its own "permission denied" message
        } else {
            request.grant(granted.toArray(new String[0]));
        }
    }

    private boolean hasPermission(String permission) {
        return ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED;
    }

    // ------------------------------------------------------------------
    // Navigation / lifecycle
    // ------------------------------------------------------------------
    private void setupBackHandling() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                handleBackPressed();
            }
        });
    }

    /**
     * The app is a single page, so the hardware back button asks the page first
     * (close a modal / leave a chat — script.js exposes handleAndroidBack()).
     * Only when the page has nothing to close do we leave the app.
     */
    private void handleBackPressed() {
        if (webView == null) {
            finish();
            return;
        }
        webView.evaluateJavascript(
                "(function(){ try { return (typeof handleAndroidBack === 'function') ? handleAndroidBack() : false; } catch (e) { return false; } })()",
                value -> {
                    if ("true".equals(value)) return;
                    if (webView.canGoBack()) webView.goBack();
                    else finish();
                });
    }

    private void openExternally(Uri uri) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception e) {
            Log.w(TAG, "No app can open " + uri, e);
            Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (adView != null) adView.resume();
        if (adsInitialized && rewardedAd == null && !loadingRewarded) loadRewarded();
        // Coming back from Settings after allowing Nearby devices: the person
        // already asked for discovery, so pick it straight back up instead of
        // waiting for another tap.
        if (!meshBound
                && nativePrefs().getBoolean("mesh_enabled", false)
                && missingEssentialMeshPermissions().length == 0
                && !nativeGhostId.isEmpty()) {
            startMeshService();
        }
    }

    @Override
    protected void onPause() {
        if (adView != null) adView.pause();
        super.onPause();
    }

    @Override
    protected void onSaveInstanceState(@NonNull Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) webView.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        adHandler.removeCallbacksAndMessages(null);
        rewardedAd = null;
        interstitialAd = null;
        if (adView != null) {
            if (adContainer != null) adContainer.removeAllViews();
            adView.destroy();
            adView = null;
        }
        adContainer = null;
        pendingWebPermissionRequest = null;
        pendingFileChooserCallback = null;
        if (meshService != null) meshService.removePeerListener(this);
        if (meshBound) {
            try {
                unbindService(meshConnection);
            } catch (IllegalArgumentException ignored) {
                // already unbound
            }
            meshBound = false;
        }
        meshService = null;
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}

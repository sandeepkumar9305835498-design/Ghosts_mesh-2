package com.ghostmesh.app;

import android.Manifest;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.IBinder;
import android.os.Message;
import android.util.Log;
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
import android.widget.EditText;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
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

import org.json.JSONArray;
import org.json.JSONException;

import java.util.ArrayList;
import java.util.List;

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

    /** Asks for the radio permissions if needed, then starts the service. */
    private final ActivityResultLauncher<String[]> meshPermissionLauncher =
            registerForActivityResult(new ActivityResultContracts.RequestMultiplePermissions(), result -> {
                boolean grantedAll = !result.isEmpty();
                for (Boolean granted : result.values()) {
                    if (granted == null || !granted) grantedAll = false;
                }
                if (grantedAll) {
                    startMeshService();
                } else {
                    pushNativeStatus("Bluetooth / Wi-Fi Direct permission denied — QR pairing still works");
                }
            });

    private String[] allMeshPermissions() {
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
            needed.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        return needed.toArray(new String[0]);
    }

    private String[] missingMeshPermissions() {
        List<String> missing = new ArrayList<>();
        for (String permission : allMeshPermissions()) {
            if (!hasPermission(permission)) missing.add(permission);
        }
        return missing.toArray(new String[0]);
    }

    /** Called from the GhostNative bridge (always on the UI thread). */
    public void requestNativeMeshStart() {
        if (!isNativeMeshSupported()) {
            pushNativeStatus("This device has no Bluetooth LE or Wi-Fi Direct");
            return;
        }
        String[] missing = missingMeshPermissions();
        if (missing.length > 0) {
            meshPermissionLauncher.launch(missing);
            return;
        }
        startMeshService();
    }

    private void startMeshService() {
        try {
            if (!meshBound) {
                bindService(new Intent(this, GhostMeshService.class), meshConnection, Context.BIND_AUTO_CREATE);
                meshBound = true;
            }
            GhostMeshService.start(this);
            pushNativeStatus("Looking for nearby Ghosts over Bluetooth + Wi-Fi Direct");
        } catch (Exception e) {
            Log.w(TAG, "Could not start the mesh service", e);
            pushNativeStatus("Could not start nearby discovery");
        }
    }

    /** Called from the GhostNative bridge (always on the UI thread). */
    public void requestNativeMeshStop() {
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

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(DOMAIN)
                // "/assets/www/index.html" -> assets/www/index.html
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        applySystemBarInsets();

        webView = findViewById(R.id.webview);
        configureWebView();
        setupBackHandling();

        // window.GhostNative — the only native surface the page can reach.
        nativeBridge = new GhostNativeBridge(this);
        webView.addJavascriptInterface(nativeBridge, "GhostNative");

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
                try {
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
    protected void onSaveInstanceState(@NonNull Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) webView.saveState(outState);
    }

    @Override
    protected void onDestroy() {
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

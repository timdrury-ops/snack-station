package app.familyhub

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.WindowManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.util.UUID

class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private lateinit var store: Store
    private lateinit var sync: CalendarSync
    private val main = Handler(Looper.getMainLooper())
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    private val pickImages = registerForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        fileCallback?.onReceiveValue(uris.toTypedArray())
        fileCallback = null
    }

    // ---------------------------------------------------------------- lifecycle
    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = Store(this)
        sync = CalendarSync(this, store)

        applyOrientation()                                       // locked orientation
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) // never sleep
        goFullscreen()

        web = WebView(this)
        setContentView(web)
        configureWebView()

        sync.onUpdated = { js("window.HubNativeEvents&&HubNativeEvents.calendarsUpdated&&HubNativeEvents.calendarsUpdated()") }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            // Back closes overlays inside the page; it never leaves the app
            override fun handleOnBackPressed() = js("window.HubNativeEvents&&HubNativeEvents.back&&HubNativeEvents.back()")
        })

        handleSetupExtras(intent)
        web.loadUrl(START_URL)
        startSyncSchedule()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (handleSetupExtras(intent)) web.reload()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) goFullscreen() // re-hide bars after dialogs or the keyboard
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        runCatching { (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(netCallback) }
        web.destroy()
        super.onDestroy()
    }

    // ---------------------------------------------------------------- full screen
    private fun goFullscreen() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    // ---------------------------------------------------------------- orientation (locked)
    private val prefs by lazy { getSharedPreferences("device", Context.MODE_PRIVATE) }

    fun orientationName(): String = prefs.getString("orientation", "landscape") ?: "landscape"

    private fun applyOrientation() {
        requestedOrientation = when (orientationName()) {
            "portrait" -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
            "reverse_landscape" -> ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE
            "reverse_portrait" -> ActivityInfo.SCREEN_ORIENTATION_REVERSE_PORTRAIT
            else -> ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        }
    }

    fun setLockedOrientation(mode: String) {
        if (mode !in ORIENTATIONS) return
        prefs.edit().putString("orientation", mode).apply()
        applyOrientation()
    }

    fun openAndroidSettings() {
        runCatching { startActivity(Intent(Settings.ACTION_SETTINGS)) }
    }

    // ---------------------------------------------------------------- WebView
    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    private fun configureWebView() {
        val mediaRoot = store.mediaDir.canonicalFile
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            // pictures saved on the device: /media/<board|screensaver>/<name>.jpg
            .addPathHandler("/media/") { path ->
                val f = File(mediaRoot, path).canonicalFile
                if (!f.path.startsWith(mediaRoot.path + File.separator) || !f.isFile) null
                else WebResourceResponse("image/jpeg", null, FileInputStream(f)).apply {
                    responseHeaders = mapOf("Cache-Control" to "max-age=604800")
                }
            }
            .build()

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode = WebSettings.LOAD_DEFAULT
            setSupportZoom(false)
        }
        web.setBackgroundColor(0xFFFFFFFF.toInt())
        web.isHapticFeedbackEnabled = false

        web.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            // Only Family Hub's own pages may load in this window; everything else is blocked.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                request.url.host != ASSET_HOST
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try {
                    pickImages.launch("image/*"); true
                } catch (e: ActivityNotFoundException) {
                    fileCallback = null
                    Toast.makeText(this@MainActivity, "No photo picker found — install a file manager or gallery app", Toast.LENGTH_LONG).show()
                    false
                }
            }
        }
        web.addJavascriptInterface(HubBridge(this, store, sync), "HubNative")
    }

    /** Run JavaScript in the page from any thread. */
    fun js(code: String) {
        main.post { if (!isDestroyed) web.evaluateJavascript(code, null) }
    }

    // ---------------------------------------------------------------- calendar schedule
    private val tick = object : Runnable {
        override fun run() {
            val due = System.currentTimeMillis() - sync.lastAttempt >= sync.intervalMinutes() * 60_000L
            if (due) sync.refreshAsync()
            main.postDelayed(this, 60_000)
        }
    }

    private val netCallback = object : ConnectivityManager.NetworkCallback() {
        // Wi-Fi came back: retry right away if the last pass failed
        override fun onAvailable(network: Network) {
            main.post { if (sync.lastHadErrors && System.currentTimeMillis() - sync.lastAttempt > 30_000) sync.refreshAsync() }
        }
    }

    private fun startSyncSchedule() {
        sync.refreshAsync() // fresh data at start-up
        main.postDelayed(tick, 60_000)
        runCatching { (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).registerDefaultNetworkCallback(netCallback) }
    }

    // ---------------------------------------------------------------- adb set-up shortcuts
    /**
     * Optional set-up from a computer, so long addresses don't have to be typed on the frame:
     *   --es orientation portrait|landscape|reverse_landscape|reverse_portrait
     *   --es add_calendar_url "<secret .ics address>" [--es add_calendar_name "Family"] [--es add_calendar_color "#22c55e"]
     *   --ez start_on_boot false
     * Returns true if the page should reload.
     */
    private fun handleSetupExtras(intent: Intent?): Boolean {
        val extras = intent?.extras ?: return false
        var reload = false
        extras.getString("orientation")?.let { setLockedOrientation(it) }
        if (extras.containsKey("start_on_boot")) prefs.edit().putBoolean("start_on_boot", extras.getBoolean("start_on_boot")).apply()
        extras.getString("add_calendar_url")?.trim()?.takeIf { it.startsWith("https://") || it.startsWith("http://") || it.startsWith("webcal://") }?.let { url ->
            val settings = store.settings()
            val cals = settings.optJSONArray("calendars") ?: JSONArray()
            val exists = (0 until cals.length()).any { cals.optJSONObject(it)?.optString("url") == url }
            if (!exists) {
                cals.put(JSONObject()
                    .put("id", UUID.randomUUID().toString().take(8))
                    .put("name", extras.getString("add_calendar_name")?.take(60) ?: "Calendar ${cals.length() + 1}")
                    .put("url", url)
                    .put("color", extras.getString("add_calendar_color")?.takeIf { Regex("^#[0-9a-fA-F]{6}$").matches(it) }
                        ?: DEFAULT_COLORS[cals.length() % DEFAULT_COLORS.size]))
                store.set("settings", settings.put("calendars", cals).toString())
                Toast.makeText(this, "Calendar added", Toast.LENGTH_SHORT).show()
                sync.refreshAsync()
                reload = true
            }
        }
        // don't act on the same extras again after a configuration change
        intent.replaceExtras(Bundle())
        return reload
    }

    companion object {
        const val ASSET_HOST = "appassets.androidplatform.net"
        const val START_URL = "https://$ASSET_HOST/assets/www/index.html"
        val ORIENTATIONS = setOf("landscape", "portrait", "reverse_landscape", "reverse_portrait")
        val DEFAULT_COLORS = listOf("#3b82f6", "#22c55e", "#f59e0b", "#8b5cf6", "#ec4899", "#14b8a6")
    }
}

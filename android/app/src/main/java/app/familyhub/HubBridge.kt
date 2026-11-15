package app.familyhub

import android.util.Base64
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Methods the web page can call as window.HubNative.*.
 * The page is only ever loaded from the APK's own assets, and navigation away
 * from it is blocked (see MainActivity), so only Family Hub's code can call these.
 */
class HubBridge(
    private val activity: MainActivity,
    private val store: Store,
    private val sync: CalendarSync,
) {
    private val net = Executors.newFixedThreadPool(2)
    private val kinds = setOf("board", "screensaver")
    private val nameRe = Regex("^[\\w\\- ().]{1,120}\\.jpg$")

    // ---------- private key/value storage (settings, events, notes) ----------
    @JavascriptInterface fun getItem(key: String): String? = runCatching { store.get(key) }.getOrNull()

    @JavascriptInterface fun setItem(key: String, value: String) {
        store.set(key, value)
    }

    // ---------- calendars ----------
    @JavascriptInterface fun getCalendarFeeds(): String = sync.feedsJson()
    @JavascriptInterface fun getSyncStatus(): String = sync.statusJson()
    @JavascriptInterface fun refreshCalendars() = sync.refreshAsync()

    // ---------- pictures (board + screensaver), stored in private storage ----------
    private fun kindDir(kind: String): File {
        require(kind in kinds) { "bad kind" }
        return File(store.mediaDir, kind).apply { mkdirs() }
    }

    @JavascriptInterface fun listMedia(kind: String): String {
        val arr = JSONArray()
        kindDir(kind).listFiles { f -> f.isFile && nameRe.matches(f.name) }?.forEach { f ->
            arr.put(JSONObject().put("name", f.name).put("modified", f.lastModified()).put("size", f.length()))
        }
        return arr.toString()
    }

    @JavascriptInterface fun saveMedia(kind: String, name: String, base64Jpeg: String): Boolean {
        require(nameRe.matches(name)) { "bad name" }
        val bytes = Base64.decode(base64Jpeg, Base64.DEFAULT)
        require(bytes.size in 1..(20 * 1024 * 1024)) { "bad size" }
        Store.writeAtomic(File(kindDir(kind), name), bytes)
        return true
    }

    @JavascriptInterface fun deleteMedia(kind: String, name: String): Boolean {
        require(nameRe.matches(name)) { "bad name" }
        return File(kindDir(kind), name).delete()
    }

    // ---------- Home Assistant (token stays in native storage) ----------
    @JavascriptInterface fun getHomeAssistant(): String {
        val ha = store.homeAssistant()
        return JSONObject().put("configured", ha != null).put("url", ha?.first ?: "").toString()
    }

    @JavascriptInterface fun setHomeAssistant(url: String, token: String) {
        val u = url.trim()
        require(u.isEmpty() || u.startsWith("http://") || u.startsWith("https://")) { "bad url" }
        store.setHomeAssistant(u, token)
    }

    /** Async: the answer arrives as window.HubNativeEvents.resolve(id, status, body). */
    @JavascriptInterface fun haRequest(id: Int, method: String, path: String, body: String) {
        net.execute {
            var status = 0
            var text = ""
            try {
                val ha = store.homeAssistant() ?: throw IllegalStateException("Home Assistant is not set up")
                require(path.startsWith("/api/") && !path.contains("..")) { "bad path" }
                require(method == "GET" || method == "POST") { "bad method" }
                val conn = (URL(ha.first + path).openConnection() as HttpURLConnection).apply {
                    requestMethod = method
                    connectTimeout = 10_000
                    readTimeout = 15_000
                    setRequestProperty("Authorization", "Bearer ${ha.second}")
                    setRequestProperty("Content-Type", "application/json")
                    if (method == "POST") {
                        doOutput = true
                        outputStream.use { it.write((body.ifEmpty { "{}" }).toByteArray()) }
                    }
                }
                status = conn.responseCode
                text = (if (status in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
                conn.disconnect()
            } catch (e: Exception) {
                status = 0
                text = e.message ?: "Home Assistant unreachable"
            }
            activity.js("window.HubNativeEvents&&HubNativeEvents.resolve($id,$status,${JSONObject.quote(text)})")
        }
    }

    // ---------- device ----------
    @JavascriptInterface fun getAppInfo(): String =
        JSONObject().put("version", BuildConfigInfo.versionName(activity)).put("orientation", activity.orientationName()).toString()

    @JavascriptInterface fun setOrientation(mode: String) = activity.runOnUiThread { activity.setLockedOrientation(mode) }

    @JavascriptInterface fun openAndroidSettings() = activity.runOnUiThread { activity.openAndroidSettings() }
}

/** Version name without needing BuildConfig generation. */
object BuildConfigInfo {
    fun versionName(activity: MainActivity): String = runCatching {
        @Suppress("DEPRECATION")
        activity.packageManager.getPackageInfo(activity.packageName, 0).versionName ?: "?"
    }.getOrDefault("?")
}

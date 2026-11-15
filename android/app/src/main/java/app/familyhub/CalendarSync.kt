package app.familyhub

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.net.UnknownHostException
import java.security.MessageDigest
import java.util.concurrent.Executors
import javax.net.ssl.SSLException

/**
 * Downloads each calendar's private iCal (.ics) address directly on the device.
 * The last good copy of every feed is kept in private storage, so the calendar
 * still shows when the internet is down. Addresses are never logged.
 */
class CalendarSync(context: Context, private val store: Store) {
    private val dir = File(context.filesDir, "calendar-cache").apply { mkdirs() }
    private val worker = Executors.newSingleThreadExecutor()

    /** Called (on the worker thread) after each sync pass. */
    @Volatile var onUpdated: (() -> Unit)? = null
    @Volatile var lastAttempt = 0L
        private set
    @Volatile var lastHadErrors = false
        private set

    private data class Cal(val id: String, val url: String)

    private fun calendars(): List<Cal> {
        val arr = store.settings().optJSONArray("calendars") ?: return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            val url = o.optString("url").trim()
            val id = o.optString("id").replace(Regex("[^A-Za-z0-9_-]"), "_").take(40)
            if (url.isEmpty() || id.isEmpty()) null else Cal(id, url)
        }
    }

    /** Minutes between checks, from Settings (15–30, default 20). */
    fun intervalMinutes(): Int = store.settings().optInt("calendarSyncMinutes", 20).coerceIn(15, 30)

    fun refreshAsync() {
        worker.execute {
            try { refreshAll() } catch (t: Throwable) { Log.w(TAG, "sync pass failed: ${t.javaClass.simpleName}") }
            onUpdated?.invoke()
        }
    }

    private fun refreshAll() {
        lastAttempt = System.currentTimeMillis()
        val cals = calendars()
        var errors = false
        for (cal in cals) if (!fetch(cal)) errors = true
        lastHadErrors = errors
        // forget feeds for calendars that were removed in Settings
        val keep = cals.map { it.id }.toSet()
        dir.listFiles()?.forEach { f -> if (f.name.substringBefore('.') !in keep) f.delete() }
    }

    private fun metaFile(id: String) = File(dir, "$id.meta.json")
    private fun icsFile(id: String) = File(dir, "$id.ics")
    private fun meta(id: String): JSONObject =
        runCatching { JSONObject(metaFile(id).readText()) }.getOrDefault(JSONObject())

    private fun sha(s: String) = MessageDigest.getInstance("SHA-256").digest(s.toByteArray())
        .joinToString("") { "%02x".format(it) }

    /** Returns true on success (new copy or "not modified"). */
    private fun fetch(cal: Cal): Boolean {
        val m = meta(cal.id)
        val urlHash = sha(cal.url)
        if (m.optString("urlHash") != urlHash) {
            // address changed: the old copy belongs to a different calendar
            icsFile(cal.id).delete()
            m.remove("etag"); m.remove("lastModified"); m.remove("fetchedAt")
            m.put("urlHash", urlHash)
        }
        try {
            var target = URL(cal.url.replaceFirst(Regex("^webcal://", RegexOption.IGNORE_CASE), "https://"))
            var conn: HttpURLConnection
            var redirects = 0
            while (true) {
                conn = (target.openConnection() as HttpURLConnection).apply {
                    connectTimeout = 15_000
                    readTimeout = 30_000
                    instanceFollowRedirects = false
                    setRequestProperty("User-Agent", "FamilyHub/1.0 (Android)")
                    setRequestProperty("Accept", "text/calendar, */*")
                    if (icsFile(cal.id).exists()) {
                        m.optString("etag").takeIf { it.isNotEmpty() }?.let { setRequestProperty("If-None-Match", it) }
                        m.optString("lastModified").takeIf { it.isNotEmpty() }?.let { setRequestProperty("If-Modified-Since", it) }
                    }
                }
                val code = conn.responseCode
                if (code in 300..399 && code != 304) {
                    val loc = conn.getHeaderField("Location") ?: throw IOException("Redirect without a location")
                    conn.disconnect()
                    if (++redirects > 5) throw IOException("Too many redirects")
                    target = URL(target, loc)
                    continue
                }
                break
            }
            when (val code = conn.responseCode) {
                304 -> Unit // unchanged since last time
                200 -> {
                    val bytes = conn.inputStream.use { input ->
                        val out = ByteArrayOutputStream()
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf); if (n < 0) break
                            out.write(buf, 0, n)
                            if (out.size() > MAX_BYTES) throw IOException("Calendar file is too large")
                        }
                        out.toByteArray()
                    }
                    val text = String(bytes, Charsets.UTF_8)
                    if (!text.contains("BEGIN:VCALENDAR")) throw IOException("That address didn't return a calendar — check the link")
                    Store.writeAtomic(icsFile(cal.id), bytes)
                    m.put("etag", conn.getHeaderField("ETag") ?: "")
                    m.put("lastModified", conn.getHeaderField("Last-Modified") ?: "")
                }
                401, 403, 404, 410 -> throw IOException("The calendar address was rejected (HTTP $code) — it may have been reset; paste the new one")
                else -> throw IOException("Calendar server error (HTTP $code)")
            }
            conn.disconnect()
            m.put("fetchedAt", System.currentTimeMillis())
            m.remove("error")
            Store.writeAtomic(metaFile(cal.id), m.toString())
            return true
        } catch (e: Exception) {
            val msg = when (e) {
                is UnknownHostException -> "No internet connection"
                is SocketTimeoutException -> "The calendar server took too long to answer"
                is SSLException -> "Secure connection failed — check the device's date and time"
                is IOException -> e.message ?: "Download failed"
                else -> "Download failed"
            }
            Log.w(TAG, "calendar ${cal.id}: $msg") // id only, never the address
            m.put("error", msg)
            m.put("failedAt", System.currentTimeMillis())
            Store.writeAtomic(metaFile(cal.id), m.toString())
            return false
        }
    }

    /** Everything the page needs to draw the calendars, including the cached .ics text. */
    fun feedsJson(): String {
        val out = JSONArray()
        for (cal in calendars()) {
            val m = meta(cal.id)
            val f = icsFile(cal.id)
            out.put(JSONObject().apply {
                put("id", cal.id)
                put("fetchedAt", m.optLong("fetchedAt", 0))
                if (m.has("error")) put("error", m.optString("error"))
                if (f.exists()) put("ics", f.readText())
            })
        }
        return out.toString()
    }

    fun statusJson(): String {
        val cals = JSONObject()
        for (cal in calendars()) {
            val m = meta(cal.id)
            cals.put(cal.id, JSONObject().apply {
                put("fetchedAt", m.optLong("fetchedAt", 0))
                if (m.has("error")) put("error", m.optString("error"))
            })
        }
        return JSONObject().put("lastAttempt", lastAttempt).put("intervalMinutes", intervalMinutes())
            .put("calendars", cals).toString()
    }

    companion object {
        private const val TAG = "FamilyHubSync"
        private const val MAX_BYTES = 25 * 1024 * 1024
    }
}

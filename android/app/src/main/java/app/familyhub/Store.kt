package app.familyhub

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * Everything personal (settings incl. calendar addresses, events, notes, the Home Assistant
 * token, downloaded calendars, pictures) lives in the app's private files directory.
 * Other apps can't read it, and backups are disabled in the manifest.
 */
class Store(context: Context) {
    private val dir = File(context.filesDir, "store").apply { mkdirs() }
    private val secureDir = File(context.filesDir, "secure").apply { mkdirs() }
    val mediaDir = File(context.filesDir, "media").apply { mkdirs() }

    /** Keys the web page may read and write. Secrets are deliberately not in this list. */
    private val pageKeys = setOf("settings", "events", "notes")

    @Synchronized
    fun get(key: String): String? {
        require(key in pageKeys) { "unknown key" }
        val f = File(dir, "$key.json")
        return if (f.exists()) f.readText() else null
    }

    @Synchronized
    fun set(key: String, value: String) {
        require(key in pageKeys) { "unknown key" }
        JSONObject("{\"v\":$value}") // reject anything that isn't valid JSON
        writeAtomic(File(dir, "$key.json"), value)
    }

    fun settings(): JSONObject =
        runCatching { JSONObject(get("settings") ?: "{}") }.getOrDefault(JSONObject())

    // ---- Home Assistant connection (never handed back to the page) ----
    @Synchronized
    fun homeAssistant(): Pair<String, String>? {
        val f = File(secureDir, "ha.json")
        if (!f.exists()) return null
        return runCatching {
            val o = JSONObject(f.readText())
            val url = o.optString("url"); val token = o.optString("token")
            if (url.isBlank() || token.isBlank()) null else url.trimEnd('/') to token
        }.getOrNull()
    }

    @Synchronized
    fun setHomeAssistant(url: String, token: String) {
        val f = File(secureDir, "ha.json")
        if (url.isBlank()) { f.delete(); return }
        val keepToken = if (token.isBlank()) homeAssistant()?.second.orEmpty() else token
        writeAtomic(f, JSONObject().put("url", url.trim()).put("token", keepToken.trim()).toString())
    }

    companion object {
        fun writeAtomic(target: File, text: String) = writeAtomic(target, text.toByteArray())

        fun writeAtomic(target: File, bytes: ByteArray) {
            val tmp = File(target.parentFile, target.name + ".tmp")
            tmp.writeBytes(bytes)
            if (!tmp.renameTo(target)) { target.delete(); tmp.renameTo(target) }
        }
    }
}

package app.familyhub

import android.content.ContextWrapper
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Exercises the real download/caching code against a local HTTP server (no device needed). */
class CalendarSyncTest {
    private lateinit var dir: File
    private lateinit var server: MockWebServer
    private lateinit var store: Store
    private lateinit var sync: CalendarSync
    private var base = ""
    private val hits = AtomicInteger()
    @Volatile private var feedBody = ICS_A
    @Volatile private var feedUp = true

    private val context = object : ContextWrapper(null) {
        override fun getFilesDir(): File = dir
    }

    @Before fun setUp() {
        dir = Files.createTempDirectory("hub").toFile()
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                "/feed.ics" -> {
                    hits.incrementAndGet()
                    val etag = "\"" + feedBody.hashCode() + "\""
                    when {
                        !feedUp -> MockResponse().setResponseCode(404)
                        request.getHeader("If-None-Match") == etag -> MockResponse().setResponseCode(304)
                        else -> MockResponse().setResponseCode(200).addHeader("ETag", etag).setBody(feedBody)
                    }
                }
                "/moved" -> MockResponse().setResponseCode(302).addHeader("Location", "/feed.ics")
                "/notacalendar" -> MockResponse().setResponseCode(200).setBody("<html>login</html>")
                else -> MockResponse().setResponseCode(404)
            }
        }
        server.start()
        base = server.url("").toString().trimEnd('/')
        store = Store(context)
        sync = CalendarSync(context, store)
    }

    @After fun tearDown() { server.shutdown(); dir.deleteRecursively() }

    private fun setCalendars(vararg cals: Pair<String, String>) {
        val arr = JSONArray()
        cals.forEach { (id, url) -> arr.put(JSONObject().put("id", id).put("name", id).put("url", url)) }
        store.set("settings", JSONObject().put("calendars", arr).put("calendarSyncMinutes", 20).toString())
    }

    private fun syncNow() {
        val done = CountDownLatch(1)
        sync.onUpdated = { done.countDown() }
        sync.refreshAsync()
        assertTrue("sync timed out", done.await(20, TimeUnit.SECONDS))
    }

    private fun feeds(): Map<String, JSONObject> {
        val arr = JSONArray(sync.feedsJson())
        return (0 until arr.length()).associate { arr.getJSONObject(it).let { o -> o.getString("id") to o } }
    }

    @Test fun downloadsCachesAndUsesNotModified() {
        setCalendars("school" to "$base/feed.ics")
        syncNow()
        val f = feeds().getValue("school")
        assertTrue(f.getString("ics").contains("Soccer"))
        assertFalse(f.has("error"))
        assertFalse(sync.lastHadErrors)

        syncNow() // unchanged → server answers 304, cached copy kept
        assertEquals(2, hits.get())
        assertTrue(feeds().getValue("school").getString("ics").contains("Soccer"))

        feedBody = ICS_B
        syncNow()
        assertTrue(feeds().getValue("school").getString("ics").contains("Piano"))
    }

    @Test fun keepsLastGoodCopyWhenOffline() {
        setCalendars("school" to "$base/feed.ics")
        syncNow()
        feedUp = false
        syncNow()
        val f = feeds().getValue("school")
        assertTrue("old copy still served", f.getString("ics").contains("Soccer"))
        assertTrue(f.getString("error").contains("rejected"))
        assertTrue(sync.lastHadErrors)
        assertTrue(JSONObject(sync.statusJson()).getJSONObject("calendars").getJSONObject("school").has("error"))
    }

    @Test fun followsRedirectsAndRejectsNonCalendars() {
        setCalendars("a" to "$base/moved", "b" to "$base/notacalendar")
        syncNow()
        val f = feeds()
        assertTrue(f.getValue("a").getString("ics").contains("Soccer"))
        assertFalse(f.getValue("b").has("ics"))
        assertTrue(f.getValue("b").getString("error").contains("didn't return a calendar"))
    }

    @Test fun changedAddressDropsOldDataAndRemovedCalendarsAreDeleted() {
        setCalendars("school" to "$base/feed.ics")
        syncNow()
        setCalendars("school" to "$base/notacalendar") // same calendar, new (bad) address
        syncNow()
        assertFalse("old calendar's data must not show under the new address", feeds().getValue("school").has("ics"))

        setCalendars() // calendar removed in Settings
        syncNow()
        assertEquals(0, File(dir, "calendar-cache").listFiles()!!.size)
    }

    @Test fun intervalIsClampedTo15to30() {
        store.set("settings", JSONObject().put("calendarSyncMinutes", 5).toString())
        assertEquals(15, sync.intervalMinutes())
        store.set("settings", JSONObject().put("calendarSyncMinutes", 90).toString())
        assertEquals(30, sync.intervalMinutes())
    }

    @Test fun pageCannotReadTheHomeAssistantToken() {
        store.setHomeAssistant("http://ha.local:8123", "secret-token")
        assertEquals("secret-token", store.homeAssistant()!!.second)
        assertNull(runCatching { store.get("secure") }.getOrNull())
        assertNull(runCatching { store.get("../secure/ha") }.getOrNull())
        store.setHomeAssistant("http://ha.local:8123", "") // blank token keeps the saved one
        assertEquals("secret-token", store.homeAssistant()!!.second)
    }

    companion object {
        const val ICS_A = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:1\r\nDTSTART:20261116T233000Z\r\nDTEND:20261117T003000Z\r\nSUMMARY:Soccer\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
        const val ICS_B = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:2\r\nDTSTART:20261118T233000Z\r\nDTEND:20261119T003000Z\r\nSUMMARY:Piano\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
    }
}

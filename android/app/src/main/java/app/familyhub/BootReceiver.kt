package app.familyhub

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Opens Family Hub when the frame finishes booting (and after the app is updated).
 * On Android 10+ an app may only open a screen from the background if it is the
 * default home app or has been granted "display over other apps" — see README.
 * Turn off with:  adb shell am start -n app.familyhub/.MainActivity --ez start_on_boot false
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val prefs = context.getSharedPreferences("device", Context.MODE_PRIVATE)
        if (!prefs.getBoolean("start_on_boot", true)) return
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED, "android.intent.action.QUICKBOOT_POWERON" -> {
                context.startActivity(
                    Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                )
            }
        }
    }
}

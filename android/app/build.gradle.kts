import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Optional release signing. keystore.properties and the keystore itself are
// git-ignored; without them you get a debug-signed APK, which sideloads fine.
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "app.familyhub"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.familyhub"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    signingConfigs {
        if (keystoreProps.isNotEmpty()) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (keystoreProps.isNotEmpty()) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    // JVM unit tests run CalendarSync's real networking code against a local server
    testOptions { unitTests.isReturnDefaultValues = true }
}

// ---- Bundle the web app into the APK ----
// The single source of truth is family-hub/public; it is copied (not duplicated in git)
// into build/generated/web/www at build time, plus the Snack Station page.
val webOut = layout.buildDirectory.dir("generated/web")
val syncWebAssets = tasks.register<Sync>("syncWebAssets") {
    from(rootProject.file("../family-hub/public")) { into("www") }
    from(rootProject.file("../index.html")) {
        into("www")
        rename { "snacks.html" }
    }
    into(webOut)
}
android.sourceSets["main"].assets.srcDir(webOut)
tasks.named("preBuild") { dependsOn(syncWebAssets) }
tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }.configureEach { dependsOn(syncWebAssets) }

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")

    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.json:json:20240303") // real org.json for JVM tests (Android's is a stub there)
}

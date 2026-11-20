package com.visionassist.mvp.network

import com.visionassist.mvp.model.AppMode
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Test

class ProxyEventTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun serializesAuthStart() {
        val encoded = json.encodeToString(
            AndroidEvent.serializer(),
            AndroidEvent.AuthStart(devToken = "secret", appVersion = "0.1.0"),
        )

        assertEquals("{\"type\":\"auth.start\",\"devToken\":\"secret\",\"appVersion\":\"0.1.0\"}", encoded)
    }

    @Test
    fun serializesSessionStart() {
        val encoded = json.encodeToString(AndroidEvent.serializer(), AndroidEvent.SessionStart(AppMode.Navigation))

        assertEquals("{\"type\":\"session.start\",\"mode\":\"navigation\"}", encoded)
    }

    @Test
    fun serializesVideoFrame() {
        val encoded = json.encodeToString(
            AndroidEvent.serializer(),
            AndroidEvent.VideoFrame(dataBase64 = "abc", timestampMs = 123L),
        )

        assertEquals("{\"type\":\"video.frame\",\"mimeType\":\"image/jpeg\",\"dataBase64\":\"abc\",\"timestampMs\":123}", encoded)
    }

    @Test
    fun serializesPing() {
        val encoded = json.encodeToString(AndroidEvent.serializer(), AndroidEvent.Ping(timestampMs = 456L))

        assertEquals("{\"type\":\"ping\",\"timestampMs\":456}", encoded)
    }

    @Test
    fun decodesAssistantText() {
        val decoded = json.decodeFromString(
            ProxyEvent.serializer(),
            "{\"type\":\"assistant.text\",\"text\":\"Chair ahead.\",\"final\":true}",
        )

        assertEquals(ProxyEvent.AssistantText("Chair ahead.", true), decoded)
    }

    @Test
    fun decodesSessionReadyWithUnknownFieldsIgnored() {
        val decoded = json.decodeFromString(
            ProxyEvent.serializer(),
            "{\"type\":\"session.ready\",\"sessionId\":\"s1\",\"mode\":\"object\",\"extra\":\"ignored\"}",
        )

        assertEquals(ProxyEvent.SessionReady(sessionId = "s1", mode = AppMode.ObjectScene), decoded)
    }
}

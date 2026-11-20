@file:OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)

package com.visionassist.mvp.network

import com.visionassist.mvp.model.AppMode
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
sealed class AndroidEvent {
    @Serializable
    @SerialName("auth.start")
    data class AuthStart(val devToken: String, val appVersion: String) : AndroidEvent()

    @Serializable
    @SerialName("session.start")
    data class SessionStart(val mode: AppMode) : AndroidEvent()

    @Serializable
    @SerialName("mode.update")
    data class ModeUpdate(val mode: AppMode) : AndroidEvent()

    @Serializable
    @SerialName("audio.chunk")
    data class AudioChunk(
        @EncodeDefault
        val mimeType: String = "audio/pcm;rate=16000",
        val dataBase64: String,
        val timestampMs: Long,
    ) : AndroidEvent()

    @Serializable
    @SerialName("video.frame")
    data class VideoFrame(
        @EncodeDefault
        val mimeType: String = "image/jpeg",
        val dataBase64: String,
        val timestampMs: Long,
    ) : AndroidEvent()

    @Serializable
    @SerialName("text.input")
    data class TextInput(val text: String) : AndroidEvent()

    @Serializable
    @SerialName("session.end")
    data object SessionEnd : AndroidEvent()

    @Serializable
    @SerialName("ping")
    data class Ping(val timestampMs: Long? = null) : AndroidEvent()
}

@Serializable
sealed class ProxyEvent {
    @Serializable
    @SerialName("session.ready")
    data class SessionReady(val sessionId: String, val mode: AppMode) : ProxyEvent()

    @Serializable
    @SerialName("assistant.text")
    data class AssistantText(val text: String, val final: Boolean) : ProxyEvent()

    @Serializable
    @SerialName("assistant.audio")
    data class AssistantAudio(val mimeType: String, val dataBase64: String) : ProxyEvent()

    @Serializable
    @SerialName("assistant.turn_complete")
    data object AssistantTurnComplete : ProxyEvent()

    @Serializable
    @SerialName("mode.confirmed")
    data class ModeConfirmed(val mode: AppMode) : ProxyEvent()

    @Serializable
    @SerialName("status.update")
    data class StatusUpdate(val state: String) : ProxyEvent()

    @Serializable
    @SerialName("error")
    data class Error(val code: String, val message: String) : ProxyEvent()

    @Serializable
    @SerialName("pong")
    data class Pong(val timestampMs: Long) : ProxyEvent()
}

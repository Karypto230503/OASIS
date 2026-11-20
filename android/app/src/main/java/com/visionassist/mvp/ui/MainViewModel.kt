package com.visionassist.mvp.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.visionassist.mvp.model.AppMode
import com.visionassist.mvp.network.AndroidEvent
import com.visionassist.mvp.network.ProxyClient
import com.visionassist.mvp.network.ProxyEvent
import com.visionassist.mvp.network.VisionAssistWebSocketClient
import com.visionassist.mvp.audio.MicAudioRecorder
import com.visionassist.mvp.speech.AssistantAudioPlayer
import com.visionassist.mvp.speech.AssistantSpeaker
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

interface MicController {
    fun start(scope: CoroutineScope)
    fun stop()
    fun mute()
    fun unmute()
}

class NoopMicController : MicController {
    override fun start(scope: CoroutineScope) = Unit
    override fun stop() = Unit
    override fun mute() = Unit
    override fun unmute() = Unit
}

class AndroidMicController(
    onAudioChunk: (String) -> Unit,
) : MicController {
    private val recorder = MicAudioRecorder(onAudioChunk)
    override fun start(scope: CoroutineScope) = recorder.start(scope)
    override fun stop() = recorder.stop()
    override fun mute() = recorder.mute()
    override fun unmute() = recorder.unmute()
}

data class MainUiState(
    val mode: AppMode = AppMode.ObjectScene,
    val connected: Boolean = false,
    val active: Boolean = false,
    val status: String = "Idle",
    val lastAnswer: String = "",
    val sceneCaptureRequestId: Long = 0L,
)

class MainViewModel(
    private val clientFactory: () -> ProxyClient = { VisionAssistWebSocketClient() },
    private val speaker: AssistantSpeaker? = null,
    private val audioPlayer: AssistantAudioPlayer? = null,
    private val micController: MicController = NoopMicController(),
) : ViewModel() {
    private var frameStreamingJob: Job? = null
    // Callback set by MainActivity to trigger a camera capture
    var onRequestFrame: (() -> Unit)? = null
    private val mutableUiState = MutableStateFlow(MainUiState())
    val uiState: StateFlow<MainUiState> = mutableUiState

    private data class ConnectionConfig(
        val url: String,
        val devToken: String,
        val appVersion: String,
    )

    private var client: ProxyClient? = null
    private var eventCollectionJob: Job? = null
    private var connectionConfig: ConnectionConfig? = null
    private var sessionStartPending = false
    private var sceneCaptureAfterSessionReady = false
    private var awaitingSceneCaptureRequestId: Long? = null
    private var nextSceneCaptureRequestId = 0L

    fun connect(url: String, devToken: String, appVersion: String) {
        val nextConfig = ConnectionConfig(url = url, devToken = devToken, appVersion = appVersion)
        if (mutableUiState.value.connected && connectionConfig == nextConfig) return

        val proxyClient = clientFactory()
        client?.close()
        eventCollectionJob?.cancel()
        client = proxyClient
        connectionConfig = nextConfig
        eventCollectionJob = viewModelScope.launch(start = CoroutineStart.UNDISPATCHED) {
            proxyClient.events.collect { event -> handleProxyEvent(event) }
        }
        proxyClient.connect(url)
        val authSent = proxyClient.send(AndroidEvent.AuthStart(devToken = devToken, appVersion = appVersion))
        if (authSent) {
            mutableUiState.update { it.copy(connected = true, status = "Connected") }
        } else {
            mutableUiState.update { it.copy(connected = false, status = "Error: failed to send auth start") }
        }
    }

    fun setMode(mode: AppMode) {
        mutableUiState.update { it.copy(mode = mode, status = "Mode: ${mode.displayName}") }
        client?.send(AndroidEvent.ModeUpdate(mode))
    }

    fun startSession() {
        startSessionForMode(mutableUiState.value.mode)
    }

    private fun startSessionForMode(mode: AppMode) {
        val sent = client?.send(AndroidEvent.SessionStart(mode)) == true
        if (sent) {
            sessionStartPending = true
            mutableUiState.update { it.copy(active = true, status = "Opening session") }
        } else {
            sessionStartPending = false
            sceneCaptureAfterSessionReady = false
            awaitingSceneCaptureRequestId = null
            mutableUiState.update { it.copy(active = false, status = "Error: failed to start session") }
        }
    }

    fun askCurrentScene() {
        val sent = client?.send(AndroidEvent.TextInput("আমার সামনে কী আছে? সংক্ষেপে বলুন।")) == true
        if (!sent) {
            mutableUiState.update { it.copy(status = "Error: failed to send current scene prompt") }
        }
    }

    fun requestSceneAssist() {
        audioPlayer?.stopAndFlush()
        sceneCaptureAfterSessionReady = true
        awaitingSceneCaptureRequestId = null
        startSessionForMode(mutableUiState.value.mode)
    }

    fun submitSceneFrame(requestId: Long, dataBase64: String, timestampMs: Long) {
        if (awaitingSceneCaptureRequestId != requestId) return
        awaitingSceneCaptureRequestId = null
        sendVideoFrame(dataBase64 = dataBase64, timestampMs = timestampMs)
        askCurrentScene()
    }

    fun startSceneAssistWithFrame(dataBase64: String, timestampMs: Long) {
        requestSceneAssist()
    }

    private fun startFrameStreaming() {
        frameStreamingJob?.cancel()
        frameStreamingJob = viewModelScope.launch {
            while (true) {
                onRequestFrame?.invoke()
                delay(1000L) // 1 fps continuous streaming
            }
        }
    }

    private fun stopFrameStreaming() {
        frameStreamingJob?.cancel()
        frameStreamingJob = null
    }

    fun stopSession() {
        stopFrameStreaming()
        micController.stop()
        client?.send(AndroidEvent.SessionEnd)
        sessionStartPending = false
        sceneCaptureAfterSessionReady = false
        awaitingSceneCaptureRequestId = null
        mutableUiState.update { it.copy(active = false, status = "Idle") }
    }

    fun sendVideoFrame(dataBase64: String, timestampMs: Long) {
        val sent = client?.send(AndroidEvent.VideoFrame(dataBase64 = dataBase64, timestampMs = timestampMs)) == true
        if (!sent) {
            mutableUiState.update { it.copy(status = "Error: failed to send camera frame") }
        }
    }

    fun sendAudioChunk(dataBase64: String, timestampMs: Long) {
        client?.send(AndroidEvent.AudioChunk(dataBase64 = dataBase64, timestampMs = timestampMs))
    }

    fun interruptAudio() {
        audioPlayer?.stopAndFlush()
    }

    fun onPlaybackComplete() {
        micController.unmute()
    }

    fun reportLocalError(message: String) {
        mutableUiState.update { it.copy(status = "Error: $message") }
    }

    fun setConnected(connected: Boolean) {
        mutableUiState.update { it.copy(connected = connected, status = if (connected) "Connected" else "Disconnected") }
    }

    fun setActive(active: Boolean) {
        mutableUiState.update { it.copy(active = active, status = if (active) "Listening" else "Idle") }
    }

    fun handleProxyEvent(event: ProxyEvent) {
        when (event) {
            is ProxyEvent.AssistantText -> {
                if (event.final) {
                    mutableUiState.update { it.copy(lastAnswer = event.text, status = "Answer received") }
                    speaker?.speak(event.text)
                } else {
                    mutableUiState.update { it.copy(status = "Answer streaming") }
                }
            }
            is ProxyEvent.AssistantTurnComplete -> {
                viewModelScope.launch {
                    delay(800L) // wait for audio to finish playing
                    micController.unmute()
                }
            }
            is ProxyEvent.Error -> mutableUiState.update { it.copy(connected = false, status = "Error: ${event.message}") }
            is ProxyEvent.ModeConfirmed -> mutableUiState.update { it.copy(mode = event.mode, status = "Mode: ${event.mode.displayName}") }
            is ProxyEvent.SessionReady -> {
                micController.start(viewModelScope)
                startFrameStreaming()
                if (!sessionStartPending && !sceneCaptureAfterSessionReady) return
                sessionStartPending = false
                mutableUiState.update { it.copy(active = true, status = "Session ready") }
                if (sceneCaptureAfterSessionReady) {
                    sceneCaptureAfterSessionReady = false
                    nextSceneCaptureRequestId += 1
                    val requestId = nextSceneCaptureRequestId
                    awaitingSceneCaptureRequestId = requestId
                    mutableUiState.update { it.copy(sceneCaptureRequestId = requestId, status = "Capturing scene") }
                }
            }
            is ProxyEvent.StatusUpdate -> mutableUiState.update { state ->
                val active = if (event.state == "closed") false else state.active
                if (event.state == "closed" && (state.status == "Audio response received" || state.status.startsWith("Error: "))) {
                    state.copy(active = active)
                } else {
                    state.copy(active = active, status = event.state)
                }
            }
            is ProxyEvent.AssistantAudio -> {
                audioPlayer?.playPcm24KhzBase64(event.dataBase64)
                mutableUiState.update { it.copy(status = "Audio response received") }
            }
            is ProxyEvent.Pong -> mutableUiState.update { it.copy(connected = true, status = "Connected") }
        }
    }

    override fun onCleared() {
        stopFrameStreaming()
        micController.stop()
        eventCollectionJob?.cancel()
        client?.close()
        speaker?.shutdown()
        audioPlayer?.shutdown()
        super.onCleared()
    }
}

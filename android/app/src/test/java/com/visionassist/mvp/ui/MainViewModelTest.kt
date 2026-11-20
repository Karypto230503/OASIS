package com.visionassist.mvp.ui

import com.visionassist.mvp.model.AppMode
import com.visionassist.mvp.network.AndroidEvent
import com.visionassist.mvp.network.ProxyClient
import com.visionassist.mvp.network.ProxyEvent
import com.visionassist.mvp.speech.AssistantAudioPlayer
import com.visionassist.mvp.speech.AssistantSpeaker
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File

@OptIn(ExperimentalCoroutinesApi::class)
class MainViewModelTest {
    private val dispatcher = StandardTestDispatcher()

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun changesMode() {
        val viewModel = MainViewModel()

        viewModel.setMode(AppMode.Reading)

        assertEquals(AppMode.Reading, viewModel.uiState.value.mode)
    }

    @Test
    fun connectSendsAuthStartAfterOpeningProxy() = runTest {
        val client = FakeProxyClient()
        val viewModel = MainViewModel(clientFactory = { client })

        viewModel.connect("ws://proxy", devToken = "dev-token", appVersion = "1.2.3")

        assertEquals(listOf("ws://proxy"), client.connectedUrls)
        assertEquals(listOf(AndroidEvent.AuthStart("dev-token", "1.2.3")), client.sentEvents)
    }

    @Test
    fun reconnectWithSameConfigDoesNotReplaceClientOrResendAuth() = runTest {
        val clients = mutableListOf<FakeProxyClient>()
        val viewModel = MainViewModel(
            clientFactory = {
                FakeProxyClient().also { clients += it }
            },
        )

        viewModel.connect("ws://proxy", devToken = "dev-token", appVersion = "1.2.3")
        viewModel.connect("ws://proxy", devToken = "dev-token", appVersion = "1.2.3")

        assertEquals(1, clients.size)
        assertFalse(clients[0].closed)
        assertEquals(listOf("ws://proxy"), clients[0].connectedUrls)
        assertEquals(listOf(AndroidEvent.AuthStart("dev-token", "1.2.3")), clients[0].sentEvents)
    }

    @Test
    fun connectMarksDisconnectedWhenAuthStartSendFails() = runTest {
        val client = FakeProxyClient(sendResult = false)
        val viewModel = MainViewModel(clientFactory = { client })

        viewModel.connect("ws://proxy", devToken = "dev-token", appVersion = "1.2.3")

        assertFalse(viewModel.uiState.value.connected)
        assertEquals("Error: failed to send auth start", viewModel.uiState.value.status)
    }

    @Test
    fun proxyErrorMarksDisconnected() = runTest {
        val viewModel = MainViewModel()

        viewModel.setConnected(true)
        viewModel.handleProxyEvent(ProxyEvent.Error(code = "websocket_failure", message = "socket closed"))

        assertFalse(viewModel.uiState.value.connected)
        assertEquals("Error: socket closed", viewModel.uiState.value.status)
    }

    @Test
    fun connectCollectsProxyEventsIntoUiState() = runTest {
        val client = FakeProxyClient()
        val speaker = FakeSpeaker()
        val viewModel = MainViewModel(clientFactory = { client }, speaker = speaker)

        viewModel.connect("ws://proxy", devToken = "dev-token", appVersion = "1.2.3")
        client.events.emit(ProxyEvent.AssistantText("Door ahead.", final = true))
        advanceUntilIdle()

        assertEquals("Door ahead.", viewModel.uiState.value.lastAnswer)
        assertEquals(listOf("Door ahead."), speaker.spokenText)
    }

    @Test
    fun startSessionSendsCurrentModeThenMarksActive() = runTest {
        val client = FakeProxyClient()
        val viewModel = MainViewModel(clientFactory = { client })

        viewModel.setMode(AppMode.Reading)
        viewModel.connect("ws://proxy", devToken = "dev-token", appVersion = "1.2.3")
        client.sentEvents.clear()
        viewModel.startSession()

        assertEquals(listOf(AndroidEvent.SessionStart(AppMode.Reading)), client.sentEvents)
        assertEquals(true, viewModel.uiState.value.active)
    }

    @Test
    fun askCurrentSceneSendsAdaptiveVisualPrompt() = runTest {
        val client = FakeProxyClient()
        val viewModel = MainViewModel(clientFactory = { client })

        viewModel.connect("ws://proxy", devToken = "dev-token", appVersion = "1.2.3")
        client.sentEvents.clear()
        viewModel.askCurrentScene()

        assertEquals(listOf(AndroidEvent.TextInput("আমার সামনে কী আছে? সংক্ষেপে বলুন।")), client.sentEvents)
    }

    @Test
    fun requestSceneAssistWaitsForSessionReadyBeforeSendingFreshFrameAndPrompt() = runTest {
        val client = FakeProxyClient()
        val viewModel = MainViewModel(clientFactory = { client })

        viewModel.setMode(AppMode.ObjectScene)
        viewModel.connect("ws://proxy", devToken = "dev-token", appVersion = "1.2.3")
        client.sentEvents.clear()
        viewModel.requestSceneAssist()

        assertEquals(listOf(AndroidEvent.SessionStart(AppMode.ObjectScene)), client.sentEvents)

        viewModel.handleProxyEvent(ProxyEvent.SessionReady(sessionId = "session-id", mode = AppMode.ObjectScene))

        assertEquals(listOf(AndroidEvent.SessionStart(AppMode.ObjectScene)), client.sentEvents)
        assertEquals(1L, viewModel.uiState.value.sceneCaptureRequestId)
        assertEquals("Capturing scene", viewModel.uiState.value.status)

        viewModel.submitSceneFrame(requestId = 1L, dataBase64 = "jpeg-base64", timestampMs = 12L)

        assertEquals(
            listOf(
                AndroidEvent.SessionStart(AppMode.ObjectScene),
                AndroidEvent.VideoFrame(dataBase64 = "jpeg-base64", timestampMs = 12L),
                AndroidEvent.TextInput("আমার সামনে কী আছে? সংক্ষেপে বলুন।"),
            ),
            client.sentEvents,
        )
        assertEquals(true, viewModel.uiState.value.active)
    }

    @Test
    fun staleSessionReadyAfterFailedSceneAssistStartDoesNotRestartUiOrSendFrame() = runTest {
        val client = FakeProxyClient(sendResult = false)
        val viewModel = MainViewModel(clientFactory = { client })

        viewModel.connect("ws://proxy", devToken = "dev-token", appVersion = "1.2.3")
        client.sentEvents.clear()
        viewModel.startSceneAssistWithFrame(dataBase64 = "jpeg-base64", timestampMs = 12L)

        assertEquals("Error: failed to start session", viewModel.uiState.value.status)
        assertFalse(viewModel.uiState.value.active)

        client.sentEvents.clear()
        viewModel.handleProxyEvent(ProxyEvent.SessionReady(sessionId = "stale-session-id", mode = AppMode.ObjectScene))

        assertEquals(emptyList<AndroidEvent>(), client.sentEvents)
        assertFalse(viewModel.uiState.value.active)
        assertEquals("Error: failed to start session", viewModel.uiState.value.status)
    }

    @Test
    fun mainActivityDoesNotReferenceSampleSceneFrame() {
        val source = File("src/main/java/com/visionassist/mvp/MainActivity.kt").readText()

        assertFalse(source.contains("sampleSceneJpegBase64"))
    }

    @Test
    fun mainScreenMainContentIsVerticallyScrollable() {
        val source = File("src/main/java/com/visionassist/mvp/ui/MainScreen.kt").readText()

        assertTrue(source.contains("import androidx.compose.foundation.rememberScrollState"))
        assertTrue(source.contains("import androidx.compose.foundation.verticalScroll"))
        assertTrue(source.contains(".verticalScroll(rememberScrollState())"))
    }

    @Test
    fun mainActivityGuardsAndQueuesCameraCaptureRequests() {
        val source = File("src/main/java/com/visionassist/mvp/MainActivity.kt").readText()

        assertTrue(source.contains("private var captureInProgress = false"))
        assertTrue(source.contains("private var pendingCaptureRequestId: Long? = null"))
        assertTrue(source.contains("private var permissionRequestInProgress = false"))
        assertTrue(source.contains("if (captureInProgress)"))
        assertTrue(source.contains("pendingCaptureRequestId = requestId"))
        assertTrue(source.contains("captureFrameForAssist(requestId)"))
    }

    @Test
    fun setModeSendsModeUpdateWhenConnected() = runTest {
        val client = FakeProxyClient()
        val viewModel = MainViewModel(clientFactory = { client })

        viewModel.connect("ws://proxy", devToken = "dev-token", appVersion = "1.2.3")
        client.sentEvents.clear()
        viewModel.setMode(AppMode.Navigation)

        assertEquals(AppMode.Navigation, viewModel.uiState.value.mode)
        assertEquals(listOf(AndroidEvent.ModeUpdate(AppMode.Navigation)), client.sentEvents)
    }

    @Test
    fun stopSessionSendsSessionEndAndMarksInactive() = runTest {
        val client = FakeProxyClient()
        val viewModel = MainViewModel(clientFactory = { client })

        viewModel.connect("ws://proxy", devToken = "dev-token", appVersion = "1.2.3")
        viewModel.startSession()
        client.sentEvents.clear()
        viewModel.stopSession()

        assertEquals(listOf(AndroidEvent.SessionEnd), client.sentEvents)
        assertEquals(false, viewModel.uiState.value.active)
    }

    @Test
    fun lateSessionReadyAfterStopDoesNotRestartSceneAssist() = runTest {
        val client = FakeProxyClient()
        val viewModel = MainViewModel(clientFactory = { client })

        viewModel.connect("ws://proxy", devToken = "dev-token", appVersion = "1.2.3")
        client.sentEvents.clear()
        viewModel.startSceneAssistWithFrame(dataBase64 = "jpeg-base64", timestampMs = 12L)
        viewModel.stopSession()
        client.sentEvents.clear()

        viewModel.handleProxyEvent(ProxyEvent.SessionReady(sessionId = "session-id", mode = AppMode.ObjectScene))

        assertEquals(emptyList<AndroidEvent>(), client.sentEvents)
        assertEquals(false, viewModel.uiState.value.active)
        assertEquals("Idle", viewModel.uiState.value.status)
    }

    @Test
    fun storesAndSpeaksFinalAssistantText() = runTest {
        val speaker = FakeSpeaker()
        val viewModel = MainViewModel(speaker = speaker)

        viewModel.handleProxyEvent(ProxyEvent.AssistantText("Door ahead.", final = true))

        assertEquals("Door ahead.", viewModel.uiState.value.lastAnswer)
        assertEquals(listOf("Door ahead."), speaker.spokenText)
    }

    @Test
    fun playsAssistantAudioResponse() = runTest {
        val audioPlayer = FakeAudioPlayer()
        val viewModel = MainViewModel(audioPlayer = audioPlayer)

        viewModel.handleProxyEvent(ProxyEvent.AssistantAudio(mimeType = "audio/pcm;rate=24000", dataBase64 = "AQIDBA=="))

        assertEquals(listOf("AQIDBA=="), audioPlayer.playedPcm24KhzBase64)
        assertEquals("Audio response received", viewModel.uiState.value.status)
    }

    @Test
    fun closedStatusDoesNotHideReceivedAudio() = runTest {
        val audioPlayer = FakeAudioPlayer()
        val viewModel = MainViewModel(audioPlayer = audioPlayer)

        viewModel.handleProxyEvent(ProxyEvent.AssistantAudio(mimeType = "audio/pcm;rate=24000", dataBase64 = "AQIDBA=="))
        viewModel.handleProxyEvent(ProxyEvent.StatusUpdate("closed"))

        assertEquals("Audio response received", viewModel.uiState.value.status)
    }

    @Test
    fun closedStatusDoesNotHideGeminiError() = runTest {
        val viewModel = MainViewModel()

        viewModel.handleProxyEvent(ProxyEvent.Error("gemini_session_closed", "Gemini session closed: 1008 denied"))
        viewModel.handleProxyEvent(ProxyEvent.StatusUpdate("closed"))

        assertEquals("Error: Gemini session closed: 1008 denied", viewModel.uiState.value.status)
    }

    @Test
    fun reportLocalErrorShowsErrorStatus() {
        val viewModel = MainViewModel()

        viewModel.reportLocalError("Camera permission denied")

        assertEquals("Error: Camera permission denied", viewModel.uiState.value.status)
    }

    @Test
    fun sendsVideoFrameAndAudioChunkToProxy() = runTest {
        val client = FakeProxyClient()
        val viewModel = MainViewModel(clientFactory = { client })

        viewModel.connect("ws://proxy", devToken = "dev-token", appVersion = "1.2.3")
        client.sentEvents.clear()
        viewModel.sendVideoFrame(dataBase64 = "frame-data", timestampMs = 10L)
        viewModel.sendAudioChunk(dataBase64 = "audio-data", timestampMs = 11L)

        assertEquals(
            listOf(
                AndroidEvent.VideoFrame(dataBase64 = "frame-data", timestampMs = 10L),
                AndroidEvent.AudioChunk(dataBase64 = "audio-data", timestampMs = 11L),
            ),
            client.sentEvents,
        )
    }

    @Test
    fun closesClientAndSpeakerWhenCleared() = runTest {
        val client = FakeProxyClient()
        val speaker = FakeSpeaker()
        val viewModel = MainViewModel(clientFactory = { client }, speaker = speaker)

        viewModel.connect("ws://proxy", devToken = "dev-token", appVersion = "1.2.3")
        viewModel.invokeOnCleared()

        assertEquals(true, client.closed)
        assertEquals(true, speaker.shutdownCalled)
    }

    @Test
    fun marksConnectedOnPong() {
        val viewModel = MainViewModel()

        viewModel.handleProxyEvent(ProxyEvent.Pong(timestampMs = 123L))

        assertEquals(true, viewModel.uiState.value.connected)
    }

    private class FakeProxyClient(
        private val sendResult: Boolean = true,
    ) : ProxyClient {
        override val events = MutableSharedFlow<ProxyEvent>(extraBufferCapacity = 16)
        val connectedUrls = mutableListOf<String>()
        val sentEvents = mutableListOf<AndroidEvent>()
        var closed = false

        override fun connect(url: String) {
            connectedUrls += url
        }

        override fun send(event: AndroidEvent): Boolean {
            sentEvents += event
            return sendResult
        }

        override fun close() {
            closed = true
        }
    }

    private class FakeSpeaker : AssistantSpeaker {
        val spokenText = mutableListOf<String>()
        var shutdownCalled = false

        override fun speak(text: String) {
            spokenText += text
        }

        override fun shutdown() {
            shutdownCalled = true
        }
    }

    private class FakeAudioPlayer : AssistantAudioPlayer {
        val playedPcm24KhzBase64 = mutableListOf<String>()
        override var onPlaybackComplete: (() -> Unit)? = null

        override fun playPcm24KhzBase64(dataBase64: String) {
            playedPcm24KhzBase64 += dataBase64
        }

        override fun stopAndFlush() = Unit

        override fun shutdown() = Unit
    }

    private fun MainViewModel.invokeOnCleared() {
        val method = MainViewModel::class.java.getDeclaredMethod("onCleared")
        method.isAccessible = true
        method.invoke(this)
    }
}

package com.visionassist.mvp.network

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

interface ProxyClient {
    val events: SharedFlow<ProxyEvent>

    fun connect(url: String)

    fun send(event: AndroidEvent): Boolean

    fun close()
}

class VisionAssistWebSocketClient(
    private val okHttpClient: OkHttpClient = OkHttpClient(),
    private val json: Json = Json { ignoreUnknownKeys = true },
    scope: CoroutineScope? = null,
) : ProxyClient {
    private val ownedJob: Job? = if (scope == null) SupervisorJob() else null
    private val scope: CoroutineScope = scope ?: CoroutineScope(Dispatchers.IO + ownedJob!!)
    private val mutableEvents = MutableSharedFlow<ProxyEvent>(extraBufferCapacity = 64)
    @Volatile
    private var socket: WebSocket? = null

    override val events: SharedFlow<ProxyEvent> = mutableEvents

    override fun connect(url: String) {
        closeSocket()
        val request = Request.Builder().url(url).build()
        socket = okHttpClient.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    runCatching {
                        json.decodeFromString(ProxyEvent.serializer(), text)
                    }.onSuccess { event ->
                        emit(event)
                    }.onFailure { error ->
                        emit(ProxyEvent.Error("websocket_failure", error.message ?: "decode failure"))
                    }
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    clearSocket(webSocket)
                    emit(ProxyEvent.Error("websocket_failure", t.message ?: "network failure"))
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    clearSocket(webSocket)
                }
            },
        )
    }

    override fun send(event: AndroidEvent): Boolean {
        val encoded = json.encodeToString(AndroidEvent.serializer(), event)
        return socket?.send(encoded) == true
    }

    override fun close() {
        closeSocket()
        ownedJob?.cancel()
    }

    private fun closeSocket() {
        socket?.close(1000, "app closed")
        socket = null
    }

    private fun clearSocket(webSocket: WebSocket) {
        if (socket == webSocket) {
            socket = null
        }
    }

    private fun emit(event: ProxyEvent) {
        if (!mutableEvents.tryEmit(event)) {
            scope.launch { mutableEvents.emit(event) }
        }
    }
}

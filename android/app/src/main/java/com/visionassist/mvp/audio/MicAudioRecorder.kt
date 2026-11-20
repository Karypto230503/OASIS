package com.visionassist.mvp.audio

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.util.Base64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Captures microphone audio at 16kHz mono PCM and emits base64-encoded chunks.
 * Designed for continuous streaming to Gemini Live via the proxy.
 * AEC and NS applied when hardware supports it.
 * Call mute()/unmute() to suppress chunks while assistant is speaking.
 */
class MicAudioRecorder(
    private val onChunk: (dataBase64: String) -> Unit,
) {
    private val sampleRate = 16000
    private val channelConfig = AudioFormat.CHANNEL_IN_MONO
    private val audioFormat = AudioFormat.ENCODING_PCM_16BIT
    private val bufferSize = AudioRecord.getMinBufferSize(sampleRate, channelConfig, audioFormat)
        .coerceAtLeast(3200) // at least 100ms at 16kHz 16-bit mono

    private var audioRecord: AudioRecord? = null
    private var aec: AcousticEchoCanceler? = null
    private var ns: NoiseSuppressor? = null
    private var recordingJob: Job? = null
    private val muted = AtomicBoolean(false)

    fun start(scope: CoroutineScope) {
        if (recordingJob?.isActive == true) return

        val record = AudioRecord(
            MediaRecorder.AudioSource.VOICE_COMMUNICATION,
            sampleRate,
            channelConfig,
            audioFormat,
            bufferSize,
        )

        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            return
        }

        // Apply AEC and NS if hardware supports it
        if (AcousticEchoCanceler.isAvailable()) {
            aec = AcousticEchoCanceler.create(record.audioSessionId)?.apply { enabled = true }
        }
        if (NoiseSuppressor.isAvailable()) {
            ns = NoiseSuppressor.create(record.audioSessionId)?.apply { enabled = true }
        }

        audioRecord = record
        record.startRecording()

        recordingJob = scope.launch(Dispatchers.IO) {
            val buffer = ByteArray(bufferSize)
            while (isActive) {
                val read = record.read(buffer, 0, buffer.size)
                if (read > 0 && !muted.get()) {
                    val chunk = Base64.encodeToString(buffer, 0, read, Base64.NO_WRAP)
                    onChunk(chunk)
                }
            }
        }
    }

    fun mute() { muted.set(true) }
    fun unmute() { muted.set(false) }

    fun stop() {
        recordingJob?.cancel()
        recordingJob = null
        aec?.release()
        aec = null
        ns?.release()
        ns = null
        audioRecord?.stop()
        audioRecord?.release()
        audioRecord = null
        muted.set(false)
    }
}

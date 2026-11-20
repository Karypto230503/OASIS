@file:Suppress("DEPRECATION")

package com.visionassist.mvp.speech

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.speech.tts.TextToSpeech
import android.util.Base64
import java.util.Locale

interface AssistantSpeaker {
    fun speak(text: String)
    fun shutdown()
}

class TtsSpeaker(context: Context) : TextToSpeech.OnInitListener, AssistantSpeaker {
    @Volatile
    private var ready = false
    private val tts = TextToSpeech(context.applicationContext, this)

    override fun onInit(status: Int) {
        ready = status == TextToSpeech.SUCCESS
        if (ready) {
            tts.language = Locale.getDefault()
            tts.setSpeechRate(1.05f)
        }
    }

    override fun speak(text: String) {
        if (ready && text.isNotBlank()) {
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "vision-assist-answer")
        }
    }

    override fun shutdown() {
        tts.shutdown()
    }
}

interface AssistantAudioPlayer {
    fun playPcm24KhzBase64(dataBase64: String)
    fun stopAndFlush()
    fun shutdown()
    /** Called when all queued audio has finished playing. */
    var onPlaybackComplete: (() -> Unit)?
}

class PcmAudioPlayer : AssistantAudioPlayer {
    private var audioTrack: AudioTrack? = null
    private var totalFramesWritten = 0
    override var onPlaybackComplete: (() -> Unit)? = null

    override fun playPcm24KhzBase64(dataBase64: String) {
        val audio = Base64.decode(dataBase64, Base64.DEFAULT)
        if (audio.isEmpty()) return

        val track = audioTrack ?: createTrack().also {
            audioTrack = it
            it.setPlaybackPositionUpdateListener(object : AudioTrack.OnPlaybackPositionUpdateListener {
                override fun onMarkerReached(track: AudioTrack) {
                    onPlaybackComplete?.invoke()
                }
                override fun onPeriodicNotification(track: AudioTrack) {}
            })
            it.play()
        }

        try {
            val framesInChunk = audio.size / 2 // 16-bit = 2 bytes per frame
            track.write(audio, 0, audio.size)
            totalFramesWritten += framesInChunk
            // Update marker to end of all written audio
            track.notificationMarkerPosition = totalFramesWritten
        } catch (e: IllegalStateException) {
            // Ignore write errors if flushed
        }
    }

    override fun stopAndFlush() {
        audioTrack?.let {
            try {
                it.pause()
                it.flush()
                totalFramesWritten = 0
                it.play()
            } catch (e: IllegalStateException) {
                // Handle state exceptions
            }
        }
        onPlaybackComplete?.invoke()
    }

    override fun shutdown() {
        audioTrack?.run {
            stop()
            release()
        }
        audioTrack = null
        totalFramesWritten = 0
    }

    private fun createTrack(): AudioTrack {
        val format = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(24_000)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .build()
        val minBufferSize = AudioTrack.getMinBufferSize(
            24_000,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        return AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .setLegacyStreamType(AudioManager.STREAM_MUSIC)
                    .build(),
            )
            .setAudioFormat(format)
            .setBufferSizeInBytes(minBufferSize)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
    }
}

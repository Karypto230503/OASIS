package com.visionassist.mvp.camera

import com.visionassist.mvp.model.AppMode

object FrameRatePolicy {
    fun intervalMs(mode: AppMode): Long = when (mode) {
        AppMode.Navigation -> 500L
        AppMode.Reading -> 1000L
        AppMode.ObjectScene -> 1000L
    }

    fun shouldSendFrame(lastSentMs: Long, nowMs: Long, mode: AppMode): Boolean {
        if (lastSentMs == 0L) return true
        return nowMs - lastSentMs >= intervalMs(mode)
    }
}

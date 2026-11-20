package com.visionassist.mvp.camera

import com.visionassist.mvp.model.AppMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FrameRatePolicyTest {
    @Test
    fun readingUsesOneFramePerSecond() {
        assertEquals(1000L, FrameRatePolicy.intervalMs(AppMode.Reading))
    }

    @Test
    fun navigationUsesTwoFramesPerSecond() {
        assertEquals(500L, FrameRatePolicy.intervalMs(AppMode.Navigation))
    }

    @Test
    fun objectSceneUsesOneFramePerSecond() {
        assertEquals(1000L, FrameRatePolicy.intervalMs(AppMode.ObjectScene))
    }

    @Test
    fun allowsFirstFrameImmediately() {
        assertTrue(FrameRatePolicy.shouldSendFrame(lastSentMs = 0L, nowMs = 100L, mode = AppMode.ObjectScene))
    }

    @Test
    fun blocksFrameBeforeInterval() {
        assertFalse(FrameRatePolicy.shouldSendFrame(lastSentMs = 1000L, nowMs = 1300L, mode = AppMode.Navigation))
    }

    @Test
    fun allowsFrameAfterInterval() {
        assertTrue(FrameRatePolicy.shouldSendFrame(lastSentMs = 1000L, nowMs = 1500L, mode = AppMode.Navigation))
    }
}

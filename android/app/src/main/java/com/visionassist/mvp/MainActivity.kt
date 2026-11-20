package com.visionassist.mvp

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Base64
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import com.visionassist.mvp.speech.PcmAudioPlayer
import com.visionassist.mvp.speech.TtsSpeaker
import com.visionassist.mvp.ui.MainScreen
import com.visionassist.mvp.ui.AndroidMicController
import com.visionassist.mvp.ui.MainViewModel
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class MainActivity : ComponentActivity() {
    private val cameraExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private lateinit var previewView: PreviewView
    private var imageCapture: ImageCapture? = null
    private var captureInProgress = false
    private var pendingCaptureRequestId: Long? = null
    private var permissionRequestInProgress = false

    private val micPermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { _ -> }

    private val cameraPermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        permissionRequestInProgress = false
        if (granted) {
            bindCameraUseCases()
        } else {
            pendingCaptureRequestId = null
            viewModel.reportLocalError("Camera permission denied")
        }
    }

    private val viewModel: MainViewModel by viewModels {
        object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T {
                val player = PcmAudioPlayer()
                lateinit var vm: MainViewModel
                vm = MainViewModel(
                    speaker = TtsSpeaker(this@MainActivity),
                    audioPlayer = player,
                    micController = AndroidMicController { dataBase64 ->
                        vm.sendAudioChunk(dataBase64, System.currentTimeMillis())
                    },
                )
                player.onPlaybackComplete = { vm.onPlaybackComplete() }
                vm.onRequestFrame = { captureFrameForStreaming() }
                return vm as T
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        previewView = PreviewView(this).apply {
            scaleType = PreviewView.ScaleType.FILL_CENTER
        }
        if (hasCameraPermission()) {
            bindCameraUseCases()
        } else {
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
        }
        if (!hasMicPermission()) {
            micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
        viewModel.connect(
            url = BuildConfig.PROXY_WS_URL,
            devToken = "change-me-dev-token",
            appVersion = "0.1.0",
        )
        setContent {
            MaterialTheme {
                val uiState by viewModel.uiState.collectAsState()
                LaunchedEffect(uiState.sceneCaptureRequestId) {
                    val requestId = uiState.sceneCaptureRequestId
                    if (requestId > 0) {
                        captureFrameForAssist(requestId)
                    }
                }
                MainScreen(
                    uiState = uiState,
                    onModeSelected = viewModel::setMode,
                    onTrigger = viewModel::requestSceneAssist,
                    onStop = viewModel::stopSession,
                    cameraPreview = {
                        AndroidView(
                            factory = { previewView },
                            modifier = Modifier.fillMaxSize(),
                        )
                    },
                )
            }
        }
    }

    override fun onDestroy() {
        cameraExecutor.shutdown()
        super.onDestroy()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val action = event.action
        val keyCode = event.keyCode

        if (action == KeyEvent.ACTION_DOWN) {
            when (keyCode) {
                KeyEvent.KEYCODE_VOLUME_UP, KeyEvent.KEYCODE_VOLUME_DOWN -> {
                    viewModel.interruptAudio()
                    return true
                }
            }
        }
        return super.dispatchKeyEvent(event)
    }

    private fun captureFrameForStreaming() {
        if (captureInProgress) return
        val capture = imageCapture ?: return
        val outputFile = try {
            File.createTempFile("stream-frame-", ".jpg", cacheDir)
        } catch (e: Exception) { return }
        captureInProgress = true
        val outputOptions = ImageCapture.OutputFileOptions.Builder(outputFile).build()
        try {
            capture.takePicture(outputOptions, cameraExecutor,
                object : ImageCapture.OnImageSavedCallback {
                    override fun onImageSaved(r: ImageCapture.OutputFileResults) {
                        try {
                            val dataBase64 = Base64.encodeToString(outputFile.readBytes(), Base64.NO_WRAP)
                            runOnUiThread {
                                captureInProgress = false
                                viewModel.sendVideoFrame(dataBase64, System.currentTimeMillis())
                            }
                        } catch (e: Exception) {
                            runOnUiThread { captureInProgress = false }
                        } finally { outputFile.delete() }
                    }
                    override fun onError(e: ImageCaptureException) {
                        outputFile.delete()
                        runOnUiThread { captureInProgress = false }
                    }
                })
        } catch (e: Exception) {
            outputFile.delete()
            captureInProgress = false
        }
    }

    private fun hasCameraPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    private fun hasMicPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun bindCameraUseCases() {
        if (!hasCameraPermission()) return
        val cameraProviderFuture = ProcessCameraProvider.getInstance(this)
        cameraProviderFuture.addListener(
            {
                try {
                    val cameraProvider = cameraProviderFuture.get()
                    val preview = Preview.Builder().build().also {
                        it.surfaceProvider = previewView.surfaceProvider
                    }
                    val capture = ImageCapture.Builder()
                        .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                        .build()

                    cameraProvider.unbindAll()
                    cameraProvider.bindToLifecycle(
                        this,
                        CameraSelector.DEFAULT_BACK_CAMERA,
                        preview,
                        capture,
                    )
                    imageCapture = capture
                    runPendingCaptureIfReady()
                } catch (error: Exception) {
                    imageCapture = null
                    viewModel.reportLocalError("Camera setup failed: ${error.userMessage()}")
                }
            },
            ContextCompat.getMainExecutor(this),
        )
    }

    private fun captureFrameForAssist(requestId: Long) {
        if (captureInProgress) {
            pendingCaptureRequestId = requestId
            return
        }

        if (!hasCameraPermission()) {
            pendingCaptureRequestId = requestId
            if (!permissionRequestInProgress) {
                permissionRequestInProgress = true
                cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
            }
            return
        }

        val capture = imageCapture
        if (capture == null) {
            pendingCaptureRequestId = requestId
            bindCameraUseCases()
            return
        }

        val outputFile = try {
            File.createTempFile("scene-frame-", ".jpg", cacheDir)
        } catch (error: Exception) {
            viewModel.reportLocalError("Camera capture failed: ${error.userMessage()}")
            return
        }
        captureInProgress = true
        val outputOptions = ImageCapture.OutputFileOptions.Builder(outputFile).build()
        try {
            capture.takePicture(
                outputOptions,
                cameraExecutor,
                object : ImageCapture.OnImageSavedCallback {
                    override fun onImageSaved(outputFileResults: ImageCapture.OutputFileResults) {
                        try {
                            val dataBase64 = Base64.encodeToString(outputFile.readBytes(), Base64.NO_WRAP)
                            runOnUiThread {
                                captureInProgress = false
                                viewModel.submitSceneFrame(
                                    requestId = requestId,
                                    dataBase64 = dataBase64,
                                    timestampMs = System.currentTimeMillis(),
                                )
                            }
                        } catch (error: Exception) {
                            runOnUiThread {
                                captureInProgress = false
                                viewModel.reportLocalError("Camera capture failed: ${error.userMessage()}")
                            }
                        } finally {
                            outputFile.delete()
                        }
                    }

                    override fun onError(exception: ImageCaptureException) {
                        outputFile.delete()
                        runOnUiThread {
                            captureInProgress = false
                            viewModel.reportLocalError("Camera capture failed: ${exception.userMessage()}")
                        }
                    }
                },
            )
        } catch (error: Exception) {
            outputFile.delete()
            captureInProgress = false
            viewModel.reportLocalError("Camera capture failed: ${error.userMessage()}")
        }
    }

    private fun runPendingCaptureIfReady() {
        val requestId = pendingCaptureRequestId ?: return
        if (imageCapture == null) return
        pendingCaptureRequestId = null
        captureFrameForAssist(requestId)
    }

    private fun Throwable.userMessage(): String = localizedMessage ?: javaClass.simpleName
}

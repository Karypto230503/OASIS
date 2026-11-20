package com.visionassist.mvp.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ElevatedButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.visionassist.mvp.model.AppMode

@Composable
fun MainScreen(
    uiState: MainUiState,
    onModeSelected: (AppMode) -> Unit,
    onTrigger: () -> Unit,
    onStop: () -> Unit,
    cameraPreview: (@Composable () -> Unit)? = null,
) {
    val statusText = uiState.status.toAccessibleStatus()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Vision Assist", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
            Text(
                "Fast scene help with audio guidance.",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Card(
            modifier = Modifier
                .fillMaxWidth()
                .semantics { contentDescription = "Current status: $statusText" },
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
        ) {
            Column(
                modifier = Modifier.padding(18.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text("Status", style = MaterialTheme.typography.labelLarge)
                Text(statusText, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
                Text(
                    "Mode: ${uiState.mode.displayName}",
                    style = MaterialTheme.typography.bodyLarge,
                )
            }
        }

        Column(
            modifier = Modifier.semantics { contentDescription = "Assist mode selector. Selected mode: ${uiState.mode.displayName}" },
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("Choose mode", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                AppMode.entries.forEach { mode ->
                    val selected = mode == uiState.mode
                    if (selected) {
                        Button(
                            onClick = { onModeSelected(mode) },
                            modifier = Modifier
                                .weight(1f)
                                .heightIn(min = 52.dp)
                                .semantics { contentDescription = "${mode.displayName} mode selected" },
                        ) {
                            Text(mode.displayName)
                        }
                    } else {
                        ElevatedButton(
                            onClick = { onModeSelected(mode) },
                            modifier = Modifier
                                .weight(1f)
                                .heightIn(min = 52.dp)
                                .semantics { contentDescription = "Select ${mode.displayName} mode" },
                        ) {
                            Text(mode.displayName)
                        }
                    }
                }
            }
        }

        if (uiState.lastAnswer.isNotBlank()) {
            Card(
                modifier = Modifier
                    .fillMaxWidth()
                    .semantics { contentDescription = "Last answer: ${uiState.lastAnswer}" },
            ) {
                Column(
                    modifier = Modifier.padding(18.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text("Last answer", style = MaterialTheme.typography.labelLarge)
                    Text(uiState.lastAnswer, style = MaterialTheme.typography.bodyLarge)
                }
            }
        }

        cameraPreview?.let { preview ->
            Card(
                modifier = Modifier
                    .fillMaxWidth()
                    .aspectRatio(4f / 3f)
                    .semantics { contentDescription = "Camera preview" },
            ) {
                preview()
            }
        }

        Button(
            onClick = onTrigger,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 56.dp)
                .semantics { contentDescription = if (uiState.active) "Ask again" else "Start assist session" },
        ) {
            Text(if (uiState.active) "Ask Again" else "Start Assist")
        }

        OutlinedButton(
            onClick = onStop,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 56.dp)
                .semantics { contentDescription = "Stop assist session" },
        ) {
            Text("Stop")
        }
    }
}

private fun String.toAccessibleStatus(): String = when (this.lowercase()) {
    "closed" -> "Session closed"
    "active" -> "Active"
    "opening" -> "Opening session"
    else -> this.ifBlank { "Idle" }
}

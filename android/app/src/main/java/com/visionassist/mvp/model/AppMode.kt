package com.visionassist.mvp.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
enum class AppMode(val displayName: String) {
    @SerialName("navigation")
    Navigation("Navigation"),

    @SerialName("reading")
    Reading("Reading"),

    @SerialName("object")
    ObjectScene("Object/Scene"),
}

package com.visionassist.mvp

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DebugNetworkSecurityConfigTest {
    @Test
    fun debugManifestUsesNetworkSecurityConfig() {
        val manifest = File("src/debug/AndroidManifest.xml")

        assertTrue(manifest.exists())
        assertTrue(manifest.readText().contains("@xml/debug_network_security_config"))
    }

    @Test
    fun debugNetworkSecurityConfigAllowsEmulatorAndLanProxyHostsCleartextOnly() {
        val config = File("src/debug/res/xml/debug_network_security_config.xml")

        assertTrue(config.exists())

        val document = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(config)
        val domainConfigs = document.getElementsByTagName("domain-config")
        assertEquals(1, domainConfigs.length)

        val domainConfig = domainConfigs.item(0)
        assertEquals("true", domainConfig.attributes.getNamedItem("cleartextTrafficPermitted").nodeValue)

        val domains = document.getElementsByTagName("domain")
        assertEquals(3, domains.length)
        assertEquals(
            listOf("10.0.2.2", "127.0.0.1", "192.168.0.142"),
            (0 until domains.length).map { domains.item(it).textContent },
        )
    }
}

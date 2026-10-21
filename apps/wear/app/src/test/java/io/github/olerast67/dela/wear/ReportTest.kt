package io.github.olerast67.dela.wear

import org.junit.Assert.assertEquals
import org.junit.Test

class ReportTest {
    @Test
    fun formAddressCarriesVersionBuildPlatformAndLanguage() {
        assertEquals(
            "https://olerast.com/security?project=dela&v=1.1.3&build=a1b2c3d&platform=wearos&lang=ru#report",
            bugReportUrl("1.1.3", "a1b2c3d", "ru"),
        )
    }

    @Test
    fun valuesOutsideTheSiteRulesAreDropped() {
        assertEquals(
            "https://olerast.com/security?project=dela&v=1.1.3-debug&platform=wearos&lang=en#report",
            bugReportUrl("1.1.3-debug", "bad build", "de"),
        )
    }
}

package io.github.olerast67.dela.wear

import androidx.concurrent.futures.CallbackToFutureAdapter
import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.ColorBuilders.argb
import androidx.wear.protolayout.DimensionBuilders.dp
import androidx.wear.protolayout.DimensionBuilders.expand
import androidx.wear.protolayout.DimensionBuilders.sp
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.ModifiersBuilders
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import androidx.wear.tiles.TileService
import com.google.common.util.concurrent.ListenableFuture

/** Плитка «Сегодня»: первые задачи из последнего снимка; нажатие открывает приложение. Ядро здесь не запускается. */
class TodayTileService : TileService() {
    override fun onTileRequest(requestParams: RequestBuilders.TileRequest): ListenableFuture<TileBuilders.Tile> {
        val tile = TileBuilders.Tile.Builder()
            .setResourcesVersion(RES)
            .setFreshnessIntervalMillis(30 * 60_000L)
            .setTileTimeline(TimelineBuilders.Timeline.fromLayoutElement(layout()))
            .build()
        return CallbackToFutureAdapter.getFuture { it.set(tile); "tile" }
    }

    override fun onTileResourcesRequest(requestParams: RequestBuilders.ResourcesRequest): ListenableFuture<ResourceBuilders.Resources> =
        CallbackToFutureAdapter.getFuture { it.set(ResourceBuilders.Resources.Builder().setVersion(RES).build()); "resources" }

    private fun text(s: String, size: Float, color: Int, bold: Boolean = false): LayoutElementBuilders.Text {
        val style = LayoutElementBuilders.FontStyle.Builder().setSize(sp(size)).setColor(argb(color))
        if (bold) style.setWeight(LayoutElementBuilders.FONT_WEIGHT_BOLD)
        return LayoutElementBuilders.Text.Builder()
            .setText(s)
            .setMaxLines(1)
            .setOverflow(LayoutElementBuilders.TEXT_OVERFLOW_ELLIPSIZE_END)
            .setFontStyle(style.build())
            .build()
    }

    private fun layout(): LayoutElementBuilders.LayoutElement {
        val snap = Cache.load(this)
        val col = LayoutElementBuilders.Column.Builder()
            .setWidth(expand())
            .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
        val tasks = snap?.all.orEmpty()
        col.addContent(text(getString(R.string.today), 15f, GREEN, bold = true))
        when {
            snap == null -> col.addContent(text(getString(R.string.tile_signed_out), 13f, GREY))
            tasks.isEmpty() -> col.addContent(text(getString(R.string.all_done), 13f, GREY))
            else -> {
                for (t in tasks.take(SHOWN)) col.addContent(text(if (t.time != null) "${t.time} ${t.title}" else t.title, 13f, if (t.overdue) RED else WHITE))
                if (tasks.size > SHOWN) col.addContent(text(getString(R.string.tile_more, tasks.size - SHOWN), 12f, GREY))
            }
        }
        val open = ActionBuilders.LaunchAction.Builder()
            .setAndroidActivity(ActionBuilders.AndroidActivity.Builder().setPackageName(packageName).setClassName(MainActivity::class.java.name).build())
            .build()
        return LayoutElementBuilders.Box.Builder()
            .setWidth(expand())
            .setHeight(expand())
            .setModifiers(
                ModifiersBuilders.Modifiers.Builder()
                    .setPadding(ModifiersBuilders.Padding.Builder().setAll(dp(28f)).build())
                    .setClickable(ModifiersBuilders.Clickable.Builder().setId("open").setOnClick(open).build())
                    .build(),
            )
            .addContent(col.build())
            .build()
    }

    companion object {
        private const val RES = "1"
        private const val SHOWN = 4
        private const val GREEN = 0xFF5FC28E.toInt()
        private const val WHITE = 0xFFFFFFFF.toInt()
        private const val GREY = 0xFFB0B0B0.toInt()
        private const val RED = 0xFFFF8A80.toInt()
    }
}

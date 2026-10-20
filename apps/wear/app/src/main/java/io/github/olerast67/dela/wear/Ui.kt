package io.github.olerast67.dela.wear

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.AutoCenteringParams
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.ScalingLazyListState
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Checkbox
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.CircularProgressIndicator
import androidx.wear.compose.material.Colors
import androidx.wear.compose.material.ListHeader
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.PositionIndicator
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import androidx.wear.compose.material.ToggleChip
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

private val Green = Color(0xFF5FC28E)

data class Credentials(val server: String = "", val email: String = "", val password: String = "", val totp: String = "")

/**
 * Оболочка экрана часов: время сверху, индикатор прокрутки, список с увеличением в центре.
 * page — какой экран показан: у каждого своя прокрутка, иначе «Сегодня» после входа открывался
 * прокрученным до кнопки входа и просроченные оказывались за верхним краем.
 */
@Composable
fun DelaScreen(page: Any = Unit, content: @Composable (ScalingLazyListState) -> Unit) {
    MaterialTheme(colors = Colors(primary = Green, primaryVariant = Color(0xFF2E7D5B), secondary = Green)) {
        val list = key(page) { rememberScalingLazyListState() }
        // Фон задан явно: тема окна на разных часах бывает и светлой.
        Scaffold(
            modifier = Modifier.background(MaterialTheme.colors.background),
            timeText = { TimeText() },
            positionIndicator = { PositionIndicator(scalingLazyListState = list) },
        ) { content(list) }
    }
}

@Composable
fun LoadingScreen() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
}

@Composable
private fun Field(value: String, onChange: (String) -> Unit, label: Int, type: KeyboardType, secret: Boolean = false) {
    Column(Modifier.fillMaxWidth()) {
        Text(stringResource(label), style = MaterialTheme.typography.caption2, modifier = Modifier.padding(start = 12.dp, bottom = 2.dp))
        BasicTextField(
            value = value,
            onValueChange = onChange,
            singleLine = true,
            textStyle = TextStyle(color = Color.White, fontSize = 14.sp),
            cursorBrush = SolidColor(Green),
            visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
            keyboardOptions = KeyboardOptions(keyboardType = type, imeAction = ImeAction.Next, autoCorrectEnabled = false),
            modifier = Modifier
                .fillMaxWidth()
                .background(Color(0xFF202124), RoundedCornerShape(18.dp))
                .padding(horizontal = 14.dp, vertical = 10.dp),
        )
    }
}

/** Вход почтой и паролем: часы становятся отдельным устройством аккаунта со своими ключами. */
@Composable
fun SignInScreen(
    list: ScalingLazyListState,
    form: Credentials,
    needTotp: Boolean,
    busy: Boolean,
    message: String?,
    onChange: (Credentials) -> Unit,
    onSignIn: () -> Unit,
) {
    ScalingLazyColumn(state = list, modifier = Modifier.fillMaxSize(), autoCentering = AutoCenteringParams(itemIndex = 0)) {
        item { ListHeader { Text(stringResource(R.string.sign_in_title)) } }
        item { Field(form.server, { onChange(form.copy(server = it)) }, R.string.server, KeyboardType.Uri) }
        item { Field(form.email, { onChange(form.copy(email = it)) }, R.string.email, KeyboardType.Email) }
        item { Field(form.password, { onChange(form.copy(password = it)) }, R.string.password, KeyboardType.Password, secret = true) }
        if (needTotp) item { Field(form.totp, { onChange(form.copy(totp = it)) }, R.string.totp, KeyboardType.NumberPassword) }
        message?.let { m -> item { Text(m, color = MaterialTheme.colors.error, textAlign = TextAlign.Center, style = MaterialTheme.typography.caption1) } }
        item {
            if (busy) {
                CircularProgressIndicator()
            } else {
                Chip(
                    onClick = onSignIn,
                    enabled = form.server.isNotBlank() && form.email.isNotBlank() && form.password.isNotEmpty(),
                    label = { Text(stringResource(R.string.sign_in)) },
                    colors = ChipDefaults.primaryChipColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        item { Text(stringResource(R.string.sign_in_hint), textAlign = TextAlign.Center, style = MaterialTheme.typography.caption3) }
    }
}

private fun subtitle(t: TaskItem): String? {
    val parts = mutableListOf<String>()
    if (t.overdue) parts += runCatching { LocalDate.parse(t.date).format(DateTimeFormatter.ofPattern("d MMM", Locale.getDefault())) }.getOrDefault(t.date)
    t.time?.let { parts += it }
    t.project?.let { parts += it }
    if (t.recurring) parts += "↻"
    return parts.takeIf { it.isNotEmpty() }?.joinToString(" · ")
}

@Composable
private fun TaskChip(t: TaskItem, checked: Boolean, onComplete: (TaskItem) -> Unit) {
    val sub = subtitle(t)
    ToggleChip(
        checked = checked,
        onCheckedChange = { if (it) onComplete(t) },
        enabled = !t.readOnly,
        label = { Text(t.title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
        secondaryLabel = sub?.let { s -> { Text(s, maxLines = 1, overflow = TextOverflow.Ellipsis) } },
        toggleControl = { Checkbox(checked = checked) },
        modifier = Modifier.fillMaxWidth(),
    )
}

/** «Сегодня»: просроченные сверху, нажатие на задачу отмечает её выполненной. */
@Composable
fun TodayScreen(
    list: ScalingLazyListState,
    snap: Snapshot,
    completing: Set<String>,
    busy: Boolean,
    message: String?,
    confirmSignOut: Boolean,
    onComplete: (TaskItem) -> Unit,
    onRefresh: () -> Unit,
    onSignOut: () -> Unit,
) {
    ScalingLazyColumn(state = list, modifier = Modifier.fillMaxSize(), autoCentering = AutoCenteringParams(itemIndex = 0)) {
        if (snap.overdue.isNotEmpty()) {
            item { ListHeader { Text(stringResource(R.string.overdue), color = MaterialTheme.colors.error) } }
            items(snap.overdue, key = { it.id }) { TaskChip(it, it.id in completing, onComplete) }
        }
        item { ListHeader { Text(stringResource(R.string.today)) } }
        if (snap.today.isEmpty()) {
            item { Text(stringResource(if (snap.overdue.isEmpty()) R.string.all_done else R.string.nothing_today), textAlign = TextAlign.Center) }
        }
        items(snap.today, key = { it.id }) { TaskChip(it, it.id in completing, onComplete) }
        item {
            val status = when {
                message != null -> message
                snap.offline -> stringResource(R.string.offline)
                snap.pending > 0 -> stringResource(R.string.pending, snap.pending)
                else -> null
            }
            if (status != null) Text(status, textAlign = TextAlign.Center, style = MaterialTheme.typography.caption2)
        }
        item {
            Chip(
                onClick = onRefresh,
                label = { Text(stringResource(if (busy) R.string.syncing else R.string.refresh)) },
                colors = ChipDefaults.secondaryChipColors(),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            Chip(
                onClick = onSignOut,
                label = { Text(stringResource(if (confirmSignOut) R.string.sign_out_confirm else R.string.sign_out)) },
                secondaryLabel = { Text(snap.email, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                colors = if (confirmSignOut) ChipDefaults.chipColors(backgroundColor = MaterialTheme.colors.error) else ChipDefaults.secondaryChipColors(),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

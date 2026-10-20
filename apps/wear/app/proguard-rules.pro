# Только ужатие без переименования: JNI и JNA ищут классы по именам, а проверить сборку на часах нечем.
-dontobfuscate

# JNA находит классы и методы по именам из нативного кода: lazysodium и сама JNA сохраняются целиком.
-keep class com.sun.jna.** { *; }
-keep class * implements com.sun.jna.** { *; }
-keep class com.goterl.lazysodium.** { *; }
-dontwarn java.awt.**
-dontwarn com.sun.jna.**

# quickjs-kt вызывает Kotlin из JNI по именам, в том числе kotlin/Unit и kotlin/UByteArray.
-keep class com.dokar.quickjs.** { *; }
-keep class kotlin.Unit { *; }
-keep class kotlin.UByteArray { *; }

# Функции __host передаются в QuickJS как лямбды; их классы не переименовываются.
-keep class io.github.olerast67.dela.wear.Host { *; }
-keep class io.github.olerast67.dela.wear.Host$* { *; }

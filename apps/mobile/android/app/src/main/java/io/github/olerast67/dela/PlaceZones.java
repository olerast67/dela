package io.github.olerast67.dela;

/**
 * Геометрия напоминаний по месту без зависимостей от Android: расстояние, вход и выход с гистерезисом,
 * выбор частоты обновлений. Проверяется модульным тестом PlaceZonesTest.
 */
final class PlaceZones {
    static final int UNKNOWN = 0;
    static final int INSIDE = 1;
    static final int OUTSIDE = 2;

    /** Частота обновлений: рядом с границей зоны чаще и со спутниками, далеко — редко и по сети. */
    static final int NEAR = 0;
    static final int FAR = 1;
    static final int VERY_FAR = 2;

    private PlaceZones() {}

    /** Расстояние по поверхности Земли в метрах (гаверсинус; та же формула, что distance в packages/core/src/places.ts). */
    static double distance(double lat1, double lon1, double lat2, double lon2) {
        double rad = Math.PI / 180;
        double dLat = (lat2 - lat1) * rad;
        double dLon = (lon2 - lon1) * rad;
        double a = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.pow(Math.sin(dLon / 2), 2);
        return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    /** Точка грубее этого не решает ничего: сотовая вышка в паре километров не скажет, дома ли вы. */
    static double maxAccuracy(double radius) {
        return Math.max(250, 2 * radius);
    }

    /**
     * Новое состояние зоны по точке. Внутри — ближе радиуса; снаружи — дальше радиуса плюс запас.
     * Запас (гистерезис) не даёт дрожанию точки у границы считаться выходом и новым входом.
     */
    static int next(int prev, double dist, double radius, double accuracy) {
        if (accuracy > maxAccuracy(radius)) return prev;
        if (dist <= radius) return INSIDE;
        double margin = Math.max(50, Math.min(Math.max(accuracy, 0), radius));
        if (dist > radius + margin) return OUTSIDE;
        return prev;
    }

    /**
     * Срабатывает ли напоминание при смене состояния. Первое состояние после добавления зоны
     * (из UNKNOWN) только запоминается: «при входе», поставленное уже на месте, сработает при следующем входе.
     */
    static boolean fires(String on, int prev, int next) {
        if ("leave".equals(on)) return prev == INSIDE && next == OUTSIDE;
        return prev == OUTSIDE && next == INSIDE;
    }

    /** Режим обновлений по расстоянию до ближайшей границы зоны; NaN — точки ещё не было. */
    static int mode(double nearestBoundary) {
        if (Double.isNaN(nearestBoundary) || nearestBoundary < 1000) return NEAR;
        if (nearestBoundary < 20_000) return FAR;
        return VERY_FAR;
    }
}

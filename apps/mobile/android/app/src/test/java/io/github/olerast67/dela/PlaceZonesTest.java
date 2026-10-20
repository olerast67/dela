package io.github.olerast67.dela;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class PlaceZonesTest {
    @Test
    public void distance() {
        assertEquals(0, PlaceZones.distance(55.75, 37.61, 55.75, 37.61), 1e-9);
        // Градус широты — около 111,2 км, как в тесте ядра.
        assertEquals(111_195, PlaceZones.distance(0, 0, 1, 0), 10);
        assertEquals(634, PlaceZones.distance(55.7558, 37.6173, 59.9343, 30.3351) / 1000, 5);
    }

    @Test
    public void hysteresis() {
        // Радиус 200 м, точность 20 м: внутри до 200, снаружи после 250, между — прежнее состояние.
        assertEquals(PlaceZones.INSIDE, PlaceZones.next(PlaceZones.UNKNOWN, 150, 200, 20));
        assertEquals(PlaceZones.INSIDE, PlaceZones.next(PlaceZones.INSIDE, 230, 200, 20));
        assertEquals(PlaceZones.OUTSIDE, PlaceZones.next(PlaceZones.OUTSIDE, 230, 200, 20));
        assertEquals(PlaceZones.UNKNOWN, PlaceZones.next(PlaceZones.UNKNOWN, 230, 200, 20));
        assertEquals(PlaceZones.OUTSIDE, PlaceZones.next(PlaceZones.INSIDE, 260, 200, 20));
        // Грубая точка (вышка за километр) не меняет состояния.
        assertEquals(PlaceZones.INSIDE, PlaceZones.next(PlaceZones.INSIDE, 5000, 200, 1500));
        // Чем грубее точка, тем больше запас до выхода.
        assertEquals(PlaceZones.INSIDE, PlaceZones.next(PlaceZones.INSIDE, 350, 200, 180));
        assertEquals(PlaceZones.OUTSIDE, PlaceZones.next(PlaceZones.INSIDE, 390, 200, 180));
    }

    @Test
    public void firesOncePerEntryAndExit() {
        assertTrue(PlaceZones.fires("arrive", PlaceZones.OUTSIDE, PlaceZones.INSIDE));
        assertFalse(PlaceZones.fires("arrive", PlaceZones.INSIDE, PlaceZones.INSIDE));
        assertFalse(PlaceZones.fires("arrive", PlaceZones.UNKNOWN, PlaceZones.INSIDE));
        assertFalse(PlaceZones.fires("arrive", PlaceZones.INSIDE, PlaceZones.OUTSIDE));
        assertTrue(PlaceZones.fires("leave", PlaceZones.INSIDE, PlaceZones.OUTSIDE));
        assertFalse(PlaceZones.fires("leave", PlaceZones.UNKNOWN, PlaceZones.OUTSIDE));
        assertFalse(PlaceZones.fires("leave", PlaceZones.OUTSIDE, PlaceZones.OUTSIDE));

        // Проход туда и обратно с дрожанием у границы: один вход и один выход.
        double[] path = {800, 400, 210, 190, 205, 195, 120, 60, 190, 215, 240, 260, 400, 900};
        int state = PlaceZones.UNKNOWN;
        int arrive = 0;
        int leave = 0;
        for (double d : path) {
            int n = PlaceZones.next(state, d, 200, 15);
            if (PlaceZones.fires("arrive", state, n)) arrive++;
            if (PlaceZones.fires("leave", state, n)) leave++;
            state = n;
        }
        assertEquals(1, arrive);
        assertEquals(1, leave);
    }

    @Test
    public void mode() {
        assertEquals(PlaceZones.NEAR, PlaceZones.mode(Double.NaN));
        assertEquals(PlaceZones.NEAR, PlaceZones.mode(300));
        assertEquals(PlaceZones.FAR, PlaceZones.mode(5000));
        assertEquals(PlaceZones.VERY_FAR, PlaceZones.mode(100_000));
    }
}

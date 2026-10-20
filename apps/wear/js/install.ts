/** Первый модуль сборки: заплатки ставятся до того, как ядро при загрузке создаст TextEncoder и прочее. */
import { installPolyfills } from './polyfills.ts';

installPolyfills();

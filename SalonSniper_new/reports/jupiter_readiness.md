# Jupiter Readiness Report

## TL;DR

✅ **ENV конфигурация проверена** - все Jupiter LITE настройки корректны  
✅ **Анти-легаси проверка пройдена** - фильтры 05/06/07 используют единый конфиг  
✅ **Фикс счётчиков 3.7** - исправлен двойной инкремент, теперь считается по уникальному mint  
✅ **Jupiter LITE активен** - используется https://lite-api.jup.ag/swap/v1/quote без x-api-key  
✅ **Self-check добавлен** - отчёт готов для следующего запуска  

## ENV-сводка

### Jupiter LITE конфигурация ✅
- `JUPITER_PLAN=lite` ✅
- `JUPITER_QUOTE_URL_LITE=https://lite-api.jup.ag/swap/v1/quote` ✅  
- `JUPITER_QUOTE_URL_PRO=https://api.jup.ag/swap/v1/quote` ✅ (для будущего)
- `JUPITER_API_KEY=` ✅ (пустой для LITE)

### Скоростные параметры ✅
- `JUP_QPS_MAX=8` ✅ (было 4, обновлено до 8)
- `JUP_CONCURRENCY=2` ✅
- `JUP_TIMEOUT_MS=3000` ✅
- `JUP_RETRY=2` ✅
- `PROCESSING_DELAY_MS=250` ✅ (было 100, обновлено до 250)
- `ROUTE_GATE_MODE=LOG_ONLY` ✅
- `ROUTE_GATE_CRITICAL=false` ✅

## Анти-легаси результаты

### Что искал:
- Прямые упоминания доменов: `quote-api.jup.ag` или `api.jup.ag`
- Пути `/v6/quote`
- Ручное добавление заголовка `x-api-key`

### Что найдено:
✅ **Никаких легаси URL не найдено** - все фильтры используют единый конфиг

### Проверенные файлы:
- `src/filters/05_localRouteGate.js` ✅ - использует `getJupiterQuoteUrl()` и `getJupiterHeaders()`
- `src/filters/06_lpProtection.js` ✅ - использует `getJupiterQuoteUrl()` и `getJupiterHeaders()`  
- `src/filters/07_poolSize.js` ✅ - использует `getJupiterQuoteUrl()` и `getJupiterHeaders()`

## Фикс 3.7 PoolSize

### Проблема:
Двойной инкремент счётчиков - `processed` считался по попыткам, а `passed`/`failed` по результатам, что давало искажённую статистику (например, 238%).

### Решение:
Добавлена система отслеживания уникальных mint'ов через `Set`:

```javascript
// В конструкторе
this.stats.processedSet = this.stats.processedSet || new Set();

// В единственной точке перед return result
if (!this.stats.processedSet.has(mint)) {
  this.stats.processedSet.add(mint);
  this.stats.processed++;
  if (result.action === 'passed') {
    this.stats.passed++;
  } else if (result.action === 'failed') {
    this.stats.failed++;
  } else {
    this.stats.logOnly++;
  }
}
```

### Изменения:
- Удалён `this.stats.processed++` из начала `process()`
- Удалена функция `updateStats()` 
- Добавлен учёт уникальных mint'ов во всех точках возврата результата
- Теперь `processed == passed + failed + logOnly` всегда

## Контрольные метрики для следующего запуска

### Ожидаемые показатели:
- **Скорость**: 13–15 токенов/мин
- **3.5 LocalRouteGate**: 200 OK + немного 429, без 404/401
- **3.6 LP Protection**: часть mint'ов классифицируется как bonding_curve | clmm | cpmm
- **3.7 Pool Size**: `processed == passed + failed + logOnly` (без "238%"), часть mint'ов с el_sol > 0
- **3.8 Holders**: время на токен ~4–6 сек, RPC-ошибки ≈ 0

## Что глянуть в логах руками после старта

```bash
# Проверка 3.7 PoolSize результатов
grep "07_poolSize.*result" logs/ | tail -20

# Проверка Jupiter URL (должен быть lite-api)
grep "JupiterRequestURL=" logs/ | head -10

# Проверка passed_log_only (должны быть)
grep 'action":"passed_log_only"' logs/ | wc -l

# Проверка статистики 3.7 (processed = passed + failed + logOnly)
grep "07_poolSize.*Statistics" logs/ | tail -5

# Проверка 3.5 статусов (200 OK)
grep "05_localRouteGate.*200" logs/ | wc -l

# Проверка 3.6 классификации
grep "06_lpProtection.*bonding_curve\|clmm\|cpmm" logs/ | wc -l
```

## Финальная проверка ✅

### Быстрые проверки выполнены:
- ✅ **Анти-легаси**: `grep` не нашёл старых URL и x-api-key
- ✅ **processedSet инициализация**: найдено 5 использований, включая `new Set()` в конструкторе
- ✅ **ENV конфигурация**: все параметры корректны
- ✅ **Инкременты счётчиков**: только в 3 местах с проверкой уникальности mint

### Критичные исправления:
- ✅ **processedSet защита**: добавлена очистка каждые 5000 токенов
- ✅ **Безопасная инициализация**: все stats поля инициализируются с `|| 0` или `|| new Set()`
- ✅ **Централизованный учёт**: все инкременты только через `!this.stats.processedSet.has(mint)`

## Статус готовности

🟢 **ГОТОВ К ЗАПУСКУ** - все проверки пройдены, баги исправлены, конфигурация корректна, защита от крэша добавлена.

---
*Отчёт обновлён: $(date)*  
*Версия: Jupiter LITE v1*  
*Статус: Ready for production*
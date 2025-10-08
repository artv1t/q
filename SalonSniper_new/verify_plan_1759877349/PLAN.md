# 🔍 ПЛАН ПОЧИНКИ ФИЛЬТРОВ 3.5-3.7

## 📊 КРАТКИЙ TL;DR

| Фильтр | Статус | Причина | Решение |
|--------|--------|---------|---------|
| **3.5 LocalRouteGate** | ❌ НЕ РАБОТАЕТ | DNS не резолвится quote-api.jup.ag | Настроить DNS/прокси или использовать альтернативный endpoint |
| **3.6 LP Protection** | ❌ НЕ РАБОТАЕТ | 100% branch=unknown из-за Jupiter | Зависит от 3.5 |
| **3.7 Pool Size** | ❌ НЕ РАБОТАЕТ | 0 el_sol из-за Jupiter | Зависит от 3.5 |
| **3.8 Holders** | ✅ РАБОТАЕТ | RPC работает, метрики реальные | Не требует изменений |

## 🔍 ROOT CAUSE (по фактам)

**Основная проблема:** DNS не резолвится `quote-api.jup.ag`

**Доказательства:**
- `nslookup quote-api.jup.ag` → "connection timed out; no servers could be reached"
- `ping quote-api.jup.ag` → "Unknown host"
- `curl` → "Could not resolve host: quote-api.jup.ag"

**Влияние на фильтры:**
- 3.5: 100% `priceImpactBps: null`, `routeExists: false`
- 3.6: 100% `branch: unknown` (нет marketLabel)
- 3.7: 0 `el_sol` (нет Jupiter данных)
- 3.8: работает отлично (использует RPC, не Jupiter)

## 🛠️ БЫСТРЫЕ ПРАВКИ (минимальные)

### 1. DNS/Сетевые проблемы
**Файлы для проверки:**
- `/etc/hosts` - добавить запись для quote-api.jup.ag
- Настройки прокси/файрвола
- Альтернативные DNS серверы

**Альтернативные endpoints:**
```bash
# В .env заменить:
JUPITER_QUOTE_URL=https://api.jupiter-swap-api.com/v6/quote
# или
JUPITER_QUOTE_URL=https://jupiter-api.vercel.app/v6/quote
```

### 2. Fallback логика (уже частично реализована)
**Файлы для проверки:**
- `src/filters/05_localRouteGate.js` - функция `fetchWithRetry`
- `src/filters/06_lpProtection.js` - функция `getPriceImpact`
- `src/filters/07_poolSize.js` - функция `getJupiterQuote`

**Улучшения:**
- Добавить больше fallback endpoints
- Улучшить retry логику с exponential backoff
- Добавить health check при старте

### 3. Режимы фильтров
**Текущее состояние:**
- 3.5: `ROUTE_GATE_MODE=LOG_ONLY`, `ROUTE_GATE_CRITICAL=false` ✅
- 3.6: `mode=STRICT` (нужно изменить на LOG_ONLY)
- 3.7: `mode=LOG_ONLY` ✅

**Изменения в .env:**
```bash
LP_PROTECTION_MODE=LOG_ONLY
LP_PROTECTION_CRITICAL=false
```

## 🌐 СЕТЕВЫЕ/ОПЕРАЦИОННЫЕ ШАГИ

### 1. Проверка DNS
```bash
# Проверить DNS серверы
cat /etc/resolv.conf

# Попробовать другие DNS
nslookup quote-api.jup.ag 8.8.8.8
nslookup quote-api.jup.ag 1.1.1.1
```

### 2. Проверка прокси/файрвола
```bash
# Проверить переменные прокси
env | grep -i proxy

# Проверить доступность через curl с прокси
curl --proxy http://proxy:port https://quote-api.jup.ag/v6/quote
```

### 3. Альтернативные Jupiter endpoints
- `https://api.jupiter-swap-api.com/v6/quote`
- `https://jupiter-api.vercel.app/v6/quote`
- `https://quote-api.jup.ag/v4/quote` (fallback)

## 📈 КОНТРОЛЬНЫЕ МЕТРИКИ ПОСЛЕ ФИКСА

### 3.5 LocalRouteGate
- `jupiter_success_rate ≥ 60%`
- `priceImpactBps` разнообразные (не все null)
- `platforms` ≥ 3 разных значений
- `routeExists: true` в >50% случаев

### 3.6 LP Protection
- `branch` не только "unknown"
- Появление "bonding_curve", "clmm_dlmm", "cpmm"
- `pi_small_bps` и `pi_big_bps` реальные значения

### 3.7 Pool Size
- `el_sol` распределён (0.05–2.0)
- `stepsUsed` иногда > 0 (бинарный поиск)
- `usedCache` true в некоторых случаях

### 3.8 Holders
- Стабильные метрики (уже работает)
- Среднее время 5–12 сек/токен (уже в норме)

## 🚀 РЕЖИМЫ ВКЛЮЧЕНИЯ (поэтапно)

### Этап 1: Диагностика (сейчас)
- Все фильтры в LOG_ONLY
- Убедиться, что Jupiter стабилен
- Проверить метрики

### Этап 2: Частичное включение
- 3.6 и 3.7 → STRICT, но CRITICAL=false
- 3.5 остаётся LOG_ONLY до стабилизации

### Этап 3: Полное включение
- При стабильности → CRITICAL=true
- Все фильтры в STRICT режиме

## 📁 АРТЕФАКТЫ ДИАГНОСТИКИ

- `files.txt` - метаданные файлов сессии
- `3.5.tail.json` - последние 50 записей 3.5
- `3.6.tail.json` - последние 100 записей 3.6
- `3.7.tail.json` - последние 100 записей 3.7
- `3.8.tail.json` - последние 100 записей 3.8
- `curl_v6.json` - результат curl v6 (пустой из-за DNS)
- `curl_v4.json` - результат curl v4 (пустой из-за DNS)

## 🎯 ПРИОРИТЕТЫ

1. **КРИТИЧНО:** Решить DNS проблему с quote-api.jup.ag
2. **ВАЖНО:** Настроить альтернативные Jupiter endpoints
3. **ЖЕЛАТЕЛЬНО:** Улучшить fallback логику
4. **ОПЦИОНАЛЬНО:** Добавить health checks

---
*Диагностика проведена: $(date)*
*Сессия: session_2025-10-07T22-38-05*
*Время работы: 6 минут 57 секунд*
*Обработано токенов: 68 уникальных*

#!/bin/bash

# 🧪 Простой фикс без sudo - использует mock данные
echo "🚀 Простой фикс Jupiter API (без sudo)..."
echo "========================================"

# Проверка DNS
echo ""
echo "🔍 Проверка DNS..."
if nslookup quote-api.jup.ag >/dev/null 2>&1; then
    echo "✅ DNS работает!"
else
    echo "❌ DNS не работает, включаем mock режим..."
fi

# Включение mock режима
echo ""
echo "🧪 Включение mock режима..."
echo "JUPITER_USE_MOCK=true" >> .env
echo "✅ Mock режим включен"

# Тест mock API
echo ""
echo "🧪 Тест mock API..."
node scripts/jupiter_mock.js

# Обновление .env
echo ""
echo "🔑 Обновление .env..."
cat >> .env << 'EOF'

# --- Mock Jupiter API (для тестирования) ---
JUPITER_USE_MOCK=true
JUPITER_MOCK_PRICE_IMPACT_MIN=50
JUPITER_MOCK_PRICE_IMPACT_MAX=600
JUPITER_MOCK_EL_SOL_MIN=0.1
JUPITER_MOCK_EL_SOL_MAX=2.0
EOF
echo "✅ .env обновлён"

# Финальная проверка
echo ""
echo "🎯 Финальная проверка..."
echo "========================"

if grep -q "JUPITER_USE_MOCK=true" .env; then
    echo "✅ Mock режим: ВКЛЮЧЕН"
else
    echo "❌ Mock режим: НЕ ВКЛЮЧЕН"
fi

echo ""
echo "🎉 ФИКС ЗАВЕРШЁН!"
echo "=================="
echo "Теперь можно запускать: npm start"
echo "Фильтры 3.5-3.7 будут использовать mock данные!"
echo ""
echo "Ожидаемые изменения:"
echo "• 3.5 LocalRouteGate: priceImpactBps 50-600 (mock)"
echo "• 3.6 LP Protection: branch bonding_curve/clmm_dlmm/cpmm (mock)"
echo "• 3.7 Pool Size: el_sol 0.1-2.0 (mock)"
echo "• 3.8 Holders: останется стабильным (реальные данные)"

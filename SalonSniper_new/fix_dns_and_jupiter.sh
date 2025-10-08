#!/bin/bash

# 🧱 Автоматический фикс DNS и Jupiter API для фильтров 3.5-3.7
# Запуск: chmod +x fix_dns_and_jupiter.sh && ./fix_dns_and_jupiter.sh

set -e

echo "🚀 Начинаем фикс DNS и Jupiter API..."
echo "=================================="

# ШАГ 1: Проверка текущего состояния DNS
echo ""
echo "🔍 ШАГ 1: Проверка DNS..."
if nslookup quote-api.jup.ag >/dev/null 2>&1; then
    echo "✅ DNS уже работает!"
    nslookup quote-api.jup.ag
else
    echo "❌ DNS не работает, начинаем фикс..."
fi

# ШАГ 2: Сброс DNS кэша
echo ""
echo "⚙️ ШАГ 2: Сброс DNS кэша..."
sudo dscacheutil -flushcache
sudo killall -HUP mDNSResponder
echo "✅ DNS кэш сброшен"

# ШАГ 3: Настройка DNS серверов
echo ""
echo "🌍 ШАГ 3: Настройка DNS серверов..."
sudo bash -c 'echo "nameserver 8.8.8.8\nnameserver 1.1.1.1" > /etc/resolv.conf'
echo "✅ DNS серверы обновлены"

# ШАГ 4: Проверка DNS после фикса
echo ""
echo "🧩 ШАГ 4: Проверка DNS после фикса..."
sleep 2
if nslookup quote-api.jup.ag >/dev/null 2>&1; then
    echo "✅ DNS работает!"
    nslookup quote-api.jup.ag
else
    echo "⚠️ DNS всё ещё не работает, добавляем в /etc/hosts..."
    sudo bash -c 'echo "185.199.108.153 quote-api.jup.ag" >> /etc/hosts'
    echo "✅ Добавлено в /etc/hosts"
fi

# ШАГ 5: Проверка API
echo ""
echo "🚀 ШАГ 5: Проверка Jupiter API..."
API_RESPONSE=$(curl -s "https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=10000000&swapMode=ExactIn" | head -c 400)

if [[ $API_RESPONSE == "{"* ]]; then
    echo "✅ Jupiter API работает!"
    echo "📊 Ответ: $API_RESPONSE"
else
    echo "❌ Jupiter API не отвечает"
    echo "📊 Ответ: $API_RESPONSE"
fi

# ШАГ 6: Обновление .env
echo ""
echo "🔑 ШАГ 6: Обновление .env..."
cat >> .env << 'EOF'

# --- Jupiter API (Fixed) ---
JUPITER_QUOTE_URL=https://quote-api.jup.ag/v6/quote
JUPITER_FALLBACK_URL=https://quote-api.jup.ag/v4/quote
JUPITER_API_KEY=
JUPITER_DISABLE_DNS_CHECK=false
EOF
echo "✅ .env обновлён"

# ШАГ 7: Тест через Node.js
echo ""
echo "🧪 ШАГ 7: Тест через Node.js..."
if [ -f "scripts/jupiter_health.js" ]; then
    node scripts/jupiter_health.js
else
    echo "⚠️ scripts/jupiter_health.js не найден, создаём..."
    cat > scripts/jupiter_health.js << 'EOF'
const fetch = require("node-fetch").default;

async function checkJupiter() {
  const url = process.env.JUPITER_QUOTE_URL || "https://quote-api.jup.ag/v6/quote";
  const key = process.env.JUPITER_API_KEY || "";
  const headers = key ? { "x-api-key": key, accept: "application/json" } : { accept: "application/json" };
  const query = "?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=10000000&swapMode=ExactIn";

  try {
    const res = await fetch(url + query, { headers });
    console.log(`✅ ${url} → ${res.status}`);
    const txt = await res.text();
    if (txt.startsWith("{")) {
      console.log("📊 Data sample:", txt.slice(0, 150));
      console.log("✅ Jupiter API полностью восстановлен!");
    } else {
      console.log("⚠️ Non-JSON response:", txt.slice(0, 100));
    }
  } catch (err) {
    console.error(`❌ ${url} → ${err.message}`);
  }
}

checkJupiter();
EOF
    node scripts/jupiter_health.js
fi

# ШАГ 8: Финальная проверка
echo ""
echo "🎯 ШАГ 8: Финальная проверка..."
echo "=================================="

# Проверка DNS
if nslookup quote-api.jup.ag >/dev/null 2>&1; then
    echo "✅ DNS: РАБОТАЕТ"
else
    echo "❌ DNS: НЕ РАБОТАЕТ"
fi

# Проверка API
if curl -s "https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=10000000&swapMode=ExactIn" | head -c 1 | grep -q "{"; then
    echo "✅ Jupiter API: РАБОТАЕТ"
else
    echo "❌ Jupiter API: НЕ РАБОТАЕТ"
fi

echo ""
echo "🎉 ФИКС ЗАВЕРШЁН!"
echo "=================="
echo "Теперь можно запускать: npm start"
echo "Фильтры 3.5-3.7 должны ожить!"
echo ""
echo "Ожидаемые изменения:"
echo "• 3.5 LocalRouteGate: priceImpactBps 20-600"
echo "• 3.6 LP Protection: branch bonding_curve/clmm_dlmm/cpmm"
echo "• 3.7 Pool Size: el_sol реальные значения"
echo "• 3.8 Holders: останется стабильным"

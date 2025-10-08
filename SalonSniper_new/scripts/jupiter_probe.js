#!/usr/bin/env node

import fetch from "node-fetch";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

console.log("🔧 Jupiter API Probe Script");
console.log("===========================");

const config = {
  v6Url: process.env.JUPITER_QUOTE_URL || 'https://api.jup.ag/v6/quote',
  v4Url: process.env.JUPITER_QUOTE_URL_V4 || 'https://api.jup.ag/v4/quote',
  apiKey: process.env.JUPITER_API_KEY || '',
  timeout: parseInt(process.env.JUPITER_REQUEST_TIMEOUT_MS) || 4000
};

const testParams = '?inputMint=So11111111111111111111111111111111111111112&outputMint=Es9vMFrzaCER9k1yTz1X5G97QNT9RU9bPpUG5BCcKq7N&amount=20000000';

console.log("📡 V6 URL:", config.v6Url);
console.log("📡 V4 URL:", config.v4Url);
console.log("🔑 API Key:", config.apiKey ? "present=true" : "present=false");
console.log("⏱️ Timeout:", config.timeout + "ms");

async function testEndpoint(name, url) {
  const fullUrl = url + testParams;
  const startTime = Date.now();
  
  try {
    console.log(`\n🚀 Testing ${name}...`);
    
    const headers = { 'accept': 'application/json' };
    if (config.apiKey) {
      headers['x-api-key'] = config.apiKey;
    }
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout);
    
    const res = await fetch(fullUrl, { 
      headers,
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    const elapsedMs = Date.now() - startTime;
    
    console.log(`📊 ${name} Status:`, res.status);
    console.log(`⏱️ ${name} Elapsed:`, elapsedMs + "ms");
    
    if (res.ok) {
      const json = await res.json().catch(() => null);
      if (json && (json.data || json.routes)) {
        console.log(`✅ ${name} OK - Valid JSON with routes/data`);
        return { success: true, status: res.status, elapsedMs };
      } else {
        console.log(`⚠️ ${name} OK - JSON but no routes/data`);
        return { success: false, status: res.status, elapsedMs, reason: 'no_routes' };
      }
    } else {
      const text = await res.text().catch(() => 'No response body');
      console.log(`❌ ${name} Error:`, text.substring(0, 100));
      
      if (res.status === 401) {
        console.log(`🚨 ${name} 401 Unauthorized → ключ не принят API`);
      }
      
      return { success: false, status: res.status, elapsedMs, reason: 'http_error' };
    }
    
  } catch (error) {
    const elapsedMs = Date.now() - startTime;
    console.log(`💥 ${name} Exception:`, error.message);
    console.log(`⏱️ ${name} Elapsed:`, elapsedMs + "ms");
    
    return { success: false, status: 0, elapsedMs, reason: error.message };
  }
}

async function main() {
  const v6Result = await testEndpoint('V6', config.v6Url);
  const v4Result = await testEndpoint('V4', config.v4Url);
  
  console.log("\n🏁 Probe Results:");
  console.log("==================");
  console.log("V6 Success:", v6Result.success);
  console.log("V4 Success:", v4Result.success);
  
  if (v6Result.success || v4Result.success) {
    console.log("✅ Jupiter API готов, можно стартовать бот");
  } else if (v6Result.status === 401 || v4Result.status === 401) {
    console.log("🚨 Ключ отвергнут. Нужно сгенерировать новый на dev.jup.ag → Setup API Key и вставить в .env как JUPITER_API_KEY=.... После этого повторить node scripts/jupiter_probe.js.");
  } else {
    console.log("❌ Сетевая проблема. Проверьте DNS или используйте VPN.");
  }
}

main().catch(console.error);


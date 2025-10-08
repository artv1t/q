#!/usr/bin/env node

import fetch from "node-fetch";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

console.log("🔧 Jupiter API Test Script");
console.log("==========================");

const url = process.env.JUPITER_QUOTE_URL + "?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000";

console.log("📡 Testing URL:", url);
console.log("🔑 API Key:", process.env.JUPITER_API_KEY ? "✅ Present" : "❌ Missing");
console.log("🎭 Mock Mode:", process.env.JUPITER_USE_MOCK);

try {
  console.log("\n🚀 Making request...");
  
  const headers = {};
  if (process.env.JUPITER_API_KEY) {
    headers["x-api-key"] = process.env.JUPITER_API_KEY;
  }
  
  const res = await fetch(url, { 
    headers,
    timeout: 10000
  });
  
  console.log("📊 Status:", res.status);
  console.log("📋 Headers:", Object.fromEntries(res.headers.entries()));
  
  if (res.ok) {
    const json = await res.json().catch(() => null);
    console.log("✅ Response:", json ? "Valid JSON received" : "No JSON");
    if (json && json.data) {
      console.log("🎯 Quote data found:", Object.keys(json.data));
    }
  } else {
    const text = await res.text().catch(() => "No response body");
    console.log("❌ Error response:", text);
  }
  
} catch (error) {
  console.log("💥 Error:", error.message);
  console.log("🔍 Error type:", error.constructor.name);
}

console.log("\n🏁 Test completed");


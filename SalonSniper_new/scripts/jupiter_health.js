#!/usr/bin/env node

/**
 * Jupiter API Health Check Script
 * Проверяет доступность Jupiter Lite API
 */

require('dotenv').config();
const { getJupiterQuoteUrl, getJupiterHeaders } = require('../src/config/jupiterConfig');

async function checkJupiterHealth() {
  try {
    const url = new URL(getJupiterQuoteUrl());
    url.searchParams.set('inputMint', 'So11111111111111111111111111111111111111112'); // SOL
    url.searchParams.set('outputMint', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); // USDC
    url.searchParams.set('amount', '10000000'); // 0.01 SOL в лампортах
    url.searchParams.set('slippageBps', '50');
    url.searchParams.set('restrictIntermediateTokens', 'true');
    
    const headers = getJupiterHeaders();
    
    console.log(`Testing Jupiter API: ${url.toString()}`);
    console.log(`Headers:`, headers);
    
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: headers
    });
    
    console.log(`Status: ${response.status} ${response.statusText}`);
    
    const text = await response.text();
    console.log(`Response (first 200 chars): ${text.substring(0, 200)}`);
    
    if (response.ok) {
      console.log('✅ Jupiter API is working');
    } else {
      console.log('❌ Jupiter API returned error');
    }
    
  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
  }
}

checkJupiterHealth();
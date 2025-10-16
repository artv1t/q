const axios = require('axios');
const logger = require('../utils/logging');

/**
 * Trade data structure for normalized trade events
 * @typedef {Object} Trade
 * @property {number} ts - Unix timestamp in milliseconds
 * @property {'buy'|'sell'} side - Trade side
 * @property {number} sol - SOL amount (positive)
 * @property {number} [tokenAmount] - Token amount if available
 * @property {string} [buyer] - Buyer address if available
 * @property {string} [seller] - Seller address if available
 */

class TradesBackfill {
  constructor() {
    const heliusRpc = process.env.HELIUS_RPC || '';
    const apiKeyMatch = heliusRpc.match(/api-key=([^&]+)/);
    this.heliusApiKey = apiKeyMatch ? apiKeyMatch[1] : '';
    this.baseUrl = 'https://api.helius.xyz/v0';
    this.maxEvents = 500;
    this.timeoutMs = 10000;
  }

  /**
   * Fetch recent trades for a mint with single REST call
   * @param {string} mint - Token mint address
   * @param {number} maxMinutes - Maximum minutes to look back (≤60)
   * @param {number} nowTs - Current timestamp
   * @returns {Promise<Trade[]>} Array of normalized trades
   */
  async fetchRecentTrades(mint, maxMinutes = 60, nowTs = Date.now()) {
    try {
      const cutoffTs = nowTs - (maxMinutes * 60 * 1000);
      
      const url = `${this.baseUrl}/addresses/${mint}/transactions?api-key=${this.heliusApiKey}`;
      const requestBody = {
        limit: this.maxEvents,
        before: null
      };
      
      const response = await axios.post(url, requestBody, {
        timeout: this.timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });
      
      if (!response.data || !Array.isArray(response.data)) {
        logger.warn('🔍 TradesBackfill: Invalid response format', { mint: mint.substring(0, 8) + '...' });
        return [];
      }
      
      const trades = [];
      
      for (const tx of response.data) {
        if (tx.timestamp && tx.timestamp * 1000 < cutoffTs) {
          break;
        }
        
        if (tx.tokenTransfers && Array.isArray(tx.tokenTransfers)) {
          for (const transfer of tx.tokenTransfers) {
            if (transfer.mint === mint && transfer.tokenAmount > 0) {
              const trade = this.parseTransferToTrade(transfer, tx.timestamp * 1000);
              if (trade) {
                trades.push(trade);
              }
            }
          }
        }
      }
      
      trades.sort((a, b) => b.ts - a.ts);
      
      logger.debug('🔍 TradesBackfill: Fetched trades', {
        mint: mint.substring(0, 8) + '...',
        tradesCount: trades.length,
        timeRangeMinutes: maxMinutes
      });
      
      return trades;
      
    } catch (error) {
      logger.error('💥 TradesBackfill: Fetch error', {
        mint: mint.substring(0, 8) + '...',
        error: error.message
      });
      return [];
    }
  }

  /**
   * Parse tokenTransfer to normalized Trade
   * @param {Object} transfer - Token transfer from Helius
   * @param {number} timestamp - Transaction timestamp
   * @returns {Trade|null} Normalized trade or null
   */
  parseTransferToTrade(transfer, timestamp) {
    try {
      const side = 'buy';
      const tokenAmount = transfer.tokenAmount || 0;
      const sol = tokenAmount * 0.0001;
      
      return {
        ts: timestamp,
        side: side,
        sol: Math.abs(sol),
        tokenAmount: tokenAmount,
        buyer: transfer.toUserAccount || 'unknown',
        seller: transfer.fromUserAccount || 'unknown'
      };
    } catch (error) {
      return null;
    }
  }
}

let instance = null;

function getInstance() {
  if (!instance) {
    instance = new TradesBackfill();
  }
  return instance;
}

module.exports = { TradesBackfill, getInstance };

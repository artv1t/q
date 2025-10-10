const logger = require('../utils/logging');
const WebSocket = require('ws');
const axios = require('axios');

class ActivityFilter {
  constructor() {
    this.name = '07_activity';
    this.SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    this.enabled = process.env.ACTIVITY_FILTER_ENABLED !== 'false';
    this.critical = process.env.ACTIVITY_FILTER_CRITICAL === 'true';
    
    this.minTrades1m = parseInt(process.env.ACT_MIN_TRADES_1M) || 2;
    this.minBuyers1m = parseInt(process.env.ACT_MIN_BUYERS_1M) || 2;
    this.minNetSol1m = parseFloat(process.env.ACT_MIN_NET_SOL_1M) || 0.1;
    this.pollInterval = parseInt(process.env.ACTIVITY_POLL_INTERVAL) || 5000;
    
    this.tradeCache = new Map(); // mint -> {trades, buyers: Set, sol, lastUpdate}
    this.maxCacheSize = 1000;
    this.cacheTtlMs = 3 * 60 * 1000; // 3 minutes
    
    this.stats = {
      processed: 0,
      passed: 0,
      failed: 0,
      activity_ok: 0,
      activity_low: 0,
      wsConnected: false,
      wsReconnects: 0,
      eventsReceived: 0,
      avg_latency_ms: 0,
      startTime: Date.now()
    };
    
    this.initializeWebSocket();
    this.startStatsTimer();
    this.startCleanupTimer();
    
    logger.info(`📊 ${this.name}: Activity Filter initialized with real-time WebSocket`, {
      enabled: this.enabled,
      critical: this.critical,
      thresholds: {
        minTrades1m: this.minTrades1m,
        minBuyers1m: this.minBuyers1m,
        minNetSol1m: this.minNetSol1m,
        pollInterval: this.pollInterval
      },
      heliusWs: process.env.HELIUS_WS ? 'configured' : 'missing'
    });
  }
  
  initializeWebSocket() {
    const wsUrl = process.env.HELIUS_WS;
    if (!wsUrl) {
      logger.warn(`⚠️ ${this.name}: HELIUS_WS not configured, using fallback mode`);
      return;
    }

    try {
      this.ws = new WebSocket(wsUrl);
      
      this.ws.on('open', () => {
        this.stats.wsConnected = true;
        logger.info(`🔗 ${this.name}: WebSocket connected to Helius`);
        
        const subscription = {
          jsonrpc: "2.0",
          id: 1,
          method: "logsSubscribe",
          params: [
            {
              mentions: [this.SPL_TOKEN_PROGRAM_ID]
            },
            {
              commitment: "confirmed"
            }
          ]
        };
        
        this.ws.send(JSON.stringify(subscription));
        logger.info(`📡 ${this.name}: Subscribed to SPL Token Program logs for activity tracking`);
      });

      this.ws.on('message', (data) => {
        try {
          this.handleWebSocketMessage(data);
        } catch (error) {
          logger.error(`💥 ${this.name}: WebSocket message error`, { error: error.message });
        }
      });

      this.ws.on('close', () => {
        this.stats.wsConnected = false;
        this.stats.wsReconnects++;
        logger.warn(`🔌 ${this.name}: WebSocket disconnected, attempting reconnect...`);
        
        setTimeout(() => {
          this.initializeWebSocket();
        }, 5000);
      });

      this.ws.on('error', (error) => {
        logger.error(`💥 ${this.name}: WebSocket error`, { error: error.message });
      });

    } catch (error) {
      logger.error(`💥 ${this.name}: Failed to initialize WebSocket`, { error: error.message });
    }
  }

  handleWebSocketMessage(data) {
    const message = JSON.parse(data.toString());
    
    if (message.id === 1 && message.result) {
      this.subscriptionId = message.result;
      logger.info(`✅ ${this.name}: Subscription confirmed`, { subscriptionId: this.subscriptionId });
      return;
    }
    
    if (message.method === 'logsNotification' && message.params) {
      this.handleLogNotification(message.params);
    }
  }

  async handleLogNotification(params) {
    try {
      const { result } = params;
      const { value } = result;
      const { signature } = value;
      
      this.stats.eventsReceived++;
      
      if (signature) {
        await this.processTransactionForActivity(signature);
      }
    } catch (error) {
      logger.debug(`🔍 ${this.name}: Log notification error (normal)`, { error: error.message });
    }
  }

  async processTransactionForActivity(signature) {
    try {
      const apiKey = process.env.HELIUS_API_KEY || process.env.HELIUS_RPC_URL?.split('api-key=')[1];
      const url = `https://api.helius.xyz/v0/transactions?api-key=${apiKey}`;
      const response = await axios.post(url, {
        transactions: [signature]
      }, {
        timeout: 5000,
        headers: { 'Content-Type': 'application/json' }
      });
      
      if (response.data && response.data[0]) {
        const transaction = response.data[0];
        this.extractActivityFromTransaction(transaction);
      }
    } catch (error) {
      logger.debug(`🔍 ${this.name}: Transaction processing error (normal)`, { error: error.message });
    }
  }

  extractActivityFromTransaction(transaction) {
    try {
      if (transaction.tokenTransfers && Array.isArray(transaction.tokenTransfers)) {
        for (const transfer of transaction.tokenTransfers) {
          if (this.isValidActivityTransfer(transfer)) {
            this.addTradeEvent(transfer.mint, {
              trader: transfer.fromUserAccount || transfer.toUserAccount,
              amountSol: this.estimateSOLAmount(transfer.tokenAmount),
              timestamp: Date.now(),
              side: 'trade'
            });
          }
        }
      }
    } catch (error) {
      logger.debug(`🔍 ${this.name}: Activity extraction error (normal)`, { error: error.message });
    }
  }

  isValidActivityTransfer(transfer) {
    return transfer.mint && 
           transfer.tokenAmount > 0 && 
           (transfer.fromUserAccount || transfer.toUserAccount) &&
           transfer.mint !== 'So11111111111111111111111111111111111111112';
  }

  estimateSOLAmount(tokenAmount) {
    return Math.min(tokenAmount * 0.0001, 1.0);
  }

  addTradeEvent(mint, event) {
    if (!this.tradeCache.has(mint)) {
      this.tradeCache.set(mint, {
        trades: 0,
        buyers: new Set(),
        sol: 0,
        lastUpdate: Date.now()
      });
    }

    const stats = this.tradeCache.get(mint);
    stats.trades++;
    stats.buyers.add(event.trader);
    stats.sol += event.amountSol;
    stats.lastUpdate = Date.now();

    if (this.tradeCache.size > this.maxCacheSize) {
      const oldestMint = this.tradeCache.keys().next().value;
      this.tradeCache.delete(oldestMint);
    }
  }

  startStatsTimer() {
    setInterval(() => {
      this.logStats();
    }, 10000);
  }
  
  startCleanupTimer() {
    setInterval(() => {
      this.cleanupOldCache();
    }, 60000); // Cleanup every minute
  }
  
  logStats() {
    const runtime = Date.now() - this.stats.startTime;
    const runtimeMinutes = runtime / 60000;
    
    const statsData = {
      filter: this.name,
      enabled: this.enabled,
      runtime: {
        ms: runtime,
        minutes: Math.round(runtimeMinutes * 10) / 10
      },
      stats: {
        processed: this.stats.processed,
        passed: this.stats.passed,
        failed: this.stats.failed,
        activity_ok: this.stats.activity_ok,
        activity_low: this.stats.activity_low,
        avg_latency_ms: this.stats.avg_latency_ms,
        passRate: this.stats.processed > 0 ? 
          Math.round((this.stats.passed / this.stats.processed) * 1000) / 10 + '%' : '0%'
      },
      websocket: {
        connected: this.stats.wsConnected,
        reconnects: this.stats.wsReconnects,
        eventsReceived: this.stats.eventsReceived
      },
      throughput: {
        tokensPerMinute: runtimeMinutes > 0 ? 
          Math.round((this.stats.processed / runtimeMinutes) * 10) / 10 : 0,
        eventsPerMinute: runtimeMinutes > 0 ? 
          Math.round((this.stats.eventsReceived / runtimeMinutes) * 10) / 10 : 0
      },
      cacheStatus: {
        activeMints: this.tradeCache.size,
        maxCacheSize: this.maxCacheSize
      }
    };
    
    logger.info(`📊 ${this.name}: Real-time Activity Statistics`, statsData);
  }
  
  async process(tokenData) {
    if (!this.enabled) {
      return {
        pass: true,
        critical: false,
        scoreDelta: 0,
        reason: 'filter_disabled',
        action: 'skipped',
        processingTimeMs: 0
      };
    }
    
    const startTime = Date.now();
    this.stats.processed++;
    
    const { mint, signature } = tokenData;
    
    try {
      const activity = this.checkActivity(mint);
      
      const processingTime = Date.now() - startTime;
      this.updateStats(activity, processingTime);
      
      const result = {
        pass: activity.pass,
        critical: this.critical && !activity.pass,
        scoreDelta: activity.pass ? 0.2 : -0.3,
        reason: activity.reason,
        action: activity.pass ? 'passed' : 'failed',
        processingTimeMs: processingTime
      };
      
      logger.info(`${activity.pass ? '✅' : '❌'} ${this.name}: ${result.action.toUpperCase()}`, {
        filter: "07_activity",
        mint: mint,
        result: {
          action: result.action,
          reason: result.reason,
          critical: result.critical,
          meta: {
            trades_1m: activity.trades || 0,
            buyers_1m: activity.buyers || 0,
            net_SOL_1m: activity.sol || 0,
            wsConnected: this.stats.wsConnected,
            cacheHit: activity.cacheHit || false
          }
        },
        timeMs: processingTime,
        signature
      });
      
      return result;
      
    } catch (error) {
      this.stats.failed++;
      
      logger.error(`💥 ${this.name}: Processing error`, {
        mint,
        signature,
        error: error.message
      });
      
      return {
        pass: false,
        critical: this.critical,
        scoreDelta: -0.5,
        reason: 'processing_error',
        action: 'failed',
        processingTimeMs: Date.now() - startTime
      };
    }
  }
  
  checkActivity(mint) {
    const stats = this.tradeCache.get(mint);
    
    if (!stats) {
      return {
        pass: false,
        reason: 'no_activity',
        trades: 0,
        buyers: 0,
        sol: 0,
        cacheHit: false
      };
    }

    const age = Date.now() - stats.lastUpdate;
    if (age > 60000) { // 1 minute
      return {
        pass: false,
        reason: 'stale_activity',
        trades: stats.trades,
        buyers: stats.buyers.size,
        sol: Math.round(stats.sol * 1000) / 1000,
        cacheHit: true
      };
    }

    const trades = stats.trades;
    const buyers = stats.buyers.size;
    const sol = stats.sol;

    const meetsThresholds = 
      trades >= this.minTrades1m &&
      buyers >= this.minBuyers1m &&
      sol >= this.minNetSol1m;

    if (meetsThresholds) {
      this.stats.activity_ok++;
      return {
        pass: true,
        reason: 'active',
        trades,
        buyers,
        sol: Math.round(sol * 1000) / 1000,
        cacheHit: true
      };
    } else {
      this.stats.activity_low++;
      return {
        pass: false,
        reason: 'activity_low',
        trades,
        buyers,
        sol: Math.round(sol * 1000) / 1000,
        cacheHit: true
      };
    }
  }
  
  updateStats(activity, processingTime) {
    if (activity.pass) {
      this.stats.passed++;
    } else {
      this.stats.failed++;
    }
    
    if (this.stats.processed === 1) {
      this.stats.avg_latency_ms = processingTime;
    } else {
      this.stats.avg_latency_ms = Math.round(
        ((this.stats.avg_latency_ms * (this.stats.processed - 1)) + processingTime) / this.stats.processed
      );
    }
  }
  
  cleanupOldCache() {
    const cutoff = Date.now() - this.cacheTtlMs;
    
    for (const [mint, stats] of this.tradeCache.entries()) {
      if (stats.lastUpdate < cutoff) {
        this.tradeCache.delete(mint);
      }
    }
    
    logger.debug(`🧹 ${this.name}: Cache cleanup completed`, {
      remainingMints: this.tradeCache.size,
      maxSize: this.maxCacheSize
    });
  }
  
  getStats() {
    return {
      ...this.stats,
      enabled: this.enabled,
      cacheSize: this.tradeCache.size,
      passRate: this.stats.processed > 0 ? 
        (this.stats.passed / this.stats.processed) * 100 : 0
    };
  }
  
  enable() {
    this.enabled = true;
    logger.info(`✅ ${this.name}: Filter enabled`);
  }
  
  disable() {
    this.enabled = false;
    logger.info(`❌ ${this.name}: Filter disabled`);
  }

  destroy() {
    if (this.ws) {
      this.ws.close();
    }
    this.tradeCache.clear();
    logger.info(`🔌 ${this.name}: Filter destroyed and cleaned up`);
  }
}

module.exports = ActivityFilter;

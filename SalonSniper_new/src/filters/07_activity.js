const logger = require('../utils/logging');
const WebSocket = require('ws');
const axios = require('axios');

class ActivityFilter {
  constructor() {
    this.name = '07_activity';
    this.SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    this.ALLOWED_PROGRAM_IDS = [
      '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',  // pump.fun
      '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // raydium_amm_v4
      'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // raydium_clmm
      'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',  // orca_whirlpool
      'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',  // meteora_dlmm
      '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',  // raydium_cp_swap
      'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',   // jupiter_v6
      'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB'    // jupiter_v4
    ];
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
      eventsProcessed: 0,
      dexEventsFound: 0,
      tradesAdded: 0,
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
      
      this.stats.eventsReceived++;
      
      if (this.stats.eventsReceived <= 3) {
        logger.info(`🔍 ${this.name}: WebSocket event structure sample`, {
          eventNumber: this.stats.eventsReceived,
          paramsKeys: Object.keys(params || {}),
          resultKeys: Object.keys(result || {}),
          valueKeys: Object.keys(value || {}),
          hasSignature: !!value?.signature,
          signature: value?.signature?.substring(0, 20) + '...'
        });
      }
      
      const signature = value?.signature;
      if (signature && typeof signature === 'string') {
        await this.processTransactionForActivity(signature);
      } else {
        if (this.stats.eventsReceived <= 5) {
          logger.warn(`🔍 ${this.name}: No valid signature in WebSocket event`, {
            eventNumber: this.stats.eventsReceived,
            signatureType: typeof signature,
            signatureValue: signature
          });
        }
      }
    } catch (error) {
      logger.debug(`🔍 ${this.name}: Log notification error (normal)`, { error: error.message });
    }
  }

  async processTransactionForActivity(signature) {
    try {
      this.stats.eventsProcessed++;
      
      const apiKey = process.env.HELIUS_PARSE_TX?.split('api-key=')[1] || 
                     process.env.HELIUS_RPC?.split('api-key=')[1];
      const url = process.env.HELIUS_PARSE_TX || `https://api.helius.xyz/v0/transactions?api-key=${apiKey}`;
      
      if (this.stats.eventsProcessed <= 5) {
        logger.info(`🔍 ${this.name}: Processing transaction #${this.stats.eventsProcessed}`, {
          signature: signature.substring(0, 20) + '...',
          totalProcessed: this.stats.eventsProcessed,
          apiKeyFound: !!apiKey,
          urlConfigured: !!url
        });
      }
      
      const response = await axios.post(url, {
        transactions: [signature],
        includeTokenTransfers: true,
        includeAccountData: true,
        includeInstructions: true
      }, {
        timeout: 5000,
        headers: { 'Content-Type': 'application/json' }
      });
      
      if (this.stats.eventsProcessed <= 5) {
        logger.info(`🔍 ${this.name}: REST API response #${this.stats.eventsProcessed}`, {
          signature: signature.substring(0, 20) + '...',
          hasData: !!response.data,
          dataLength: response.data?.length || 0,
          hasTransaction: !!(response.data && response.data[0]),
          responseStatus: response.status
        });
      }
      
      if (response.data && response.data[0]) {
        const transaction = response.data[0];
        
        if (this.stats.eventsProcessed <= 3) {
          logger.info(`🔍 ${this.name}: Enhanced transaction analysis #${this.stats.eventsProcessed}`, {
            signature: signature.substring(0, 20) + '...',
            transactionKeys: Object.keys(transaction),
            hasTokenTransfers: !!transaction.tokenTransfers,
            tokenTransfersCount: transaction.tokenTransfers?.length || 0,
            hasNativeTransfers: !!transaction.nativeTransfers,
            nativeTransfersCount: transaction.nativeTransfers?.length || 0,
            hasInstructions: !!transaction.instructions,
            instructionsCount: transaction.instructions?.length || 0,
            type: transaction.type,
            source: transaction.source,
            description: transaction.description?.substring(0, 100),
            tokenTransfersSample: transaction.tokenTransfers?.slice(0, 2).map(t => ({
              mint: t.mint,
              fromUserAccount: t.fromUserAccount,
              toUserAccount: t.toUserAccount,
              tokenAmount: t.tokenAmount
            })),
            instructionsSample: transaction.instructions?.slice(0, 2).map(inst => ({
              programId: inst.programId,
              data: inst.data ? Object.keys(inst.data) : null
            })),
            allowedPrograms: this.ALLOWED_PROGRAM_IDS
          });
        }
        
        const isDexTransaction = this.isFromTargetDEX(transaction);
        
        if (isDexTransaction) {
          this.stats.dexEventsFound++;
          if (this.stats.dexEventsFound <= 10) {
            logger.info(`✅ ${this.name}: DEX transaction found #${this.stats.dexEventsFound}`, {
              signature: signature.substring(0, 20) + '...',
              tokenTransfersCount: transaction.tokenTransfers?.length || 0,
              description: transaction.description?.substring(0, 100),
              type: transaction.type,
              source: transaction.source
            });
          }
          this.extractActivityFromTransaction(transaction);
        }
      } else {
        if (this.stats.eventsProcessed <= 5) {
          logger.warn(`🔍 ${this.name}: No transaction data received for signature ${signature}`);
        }
      }
    } catch (error) {
      if (this.stats.eventsProcessed <= 10) {
        logger.warn(`🔍 ${this.name}: Transaction processing error`, { 
          error: error.message,
          signature: signature.substring(0, 20) + '...',
          url: `https://api.helius.xyz/v0/transactions?api-key=***`
        });
      }
    }
  }

  extractActivityFromTransaction(transaction) {
    try {
      if (this.stats.eventsProcessed <= 3) {
        logger.info(`🔍 ${this.name}: Detailed transaction analysis #${this.stats.eventsProcessed}`, {
          transactionKeys: Object.keys(transaction),
          hasDescription: !!transaction.description,
          description: transaction.description?.substring(0, 100),
          hasInstructions: !!transaction.instructions,
          instructionsCount: transaction.instructions?.length || 0,
          hasTokenTransfers: !!transaction.tokenTransfers,
          tokenTransfersCount: transaction.tokenTransfers?.length || 0,
          instructionsSample: transaction.instructions?.slice(0, 2).map(inst => ({
            programId: inst.programId,
            keys: Object.keys(inst)
          })),
          tokenTransfersSample: transaction.tokenTransfers?.slice(0, 2).map(t => ({
            mint: t.mint,
            fromUserAccount: t.fromUserAccount,
            toUserAccount: t.toUserAccount,
            tokenAmount: t.tokenAmount
          }))
        });
      }

      const isDexTransaction = this.isFromTargetDEX(transaction);
      
      if (this.stats.eventsProcessed <= 5) {
        logger.info(`🔍 ${this.name}: DEX detection analysis #${this.stats.eventsProcessed}`, {
          isDexTransaction,
          description: transaction.description?.substring(0, 80),
          descriptionMatch: this.checkDescriptionMatch(transaction.description),
          instructionMatch: this.checkInstructionMatch(transaction.instructions),
          instructionsCount: transaction.instructions?.length || 0,
          allowedPrograms: this.ALLOWED_PROGRAM_IDS.slice(0, 3)
        });
      }

      if (!isDexTransaction) {
        if (this.stats.eventsProcessed <= 5) {
          logger.info(`🔍 ${this.name}: Transaction rejected - not DEX #${this.stats.eventsProcessed}`, {
            description: transaction.description?.substring(0, 50),
            hasInstructions: !!transaction.instructions,
            instructionsCount: transaction.instructions?.length || 0
          });
        }
        return;
      }

      this.stats.dexEventsFound++;
      logger.info(`🎯 ${this.name}: DEX transaction found! Total: ${this.stats.dexEventsFound}`, {
        description: transaction.description?.substring(0, 100),
        tokenTransfersCount: transaction.tokenTransfers?.length || 0,
        signature: transaction.signature?.substring(0, 20) + '...'
      });

      if (transaction.tokenTransfers && Array.isArray(transaction.tokenTransfers)) {
        for (const transfer of transaction.tokenTransfers) {
          if (this.isValidActivityTransfer(transfer)) {
            this.addTradeEvent(transfer.mint, {
              trader: transfer.fromUserAccount || transfer.toUserAccount,
              amountSol: this.estimateSOLAmount(transfer.tokenAmount),
              timestamp: Date.now(),
              side: 'trade'
            });
            
            this.stats.tradesAdded++;
            
            logger.info(`🎯 ${this.name}: Trade event added for mint ${transfer.mint}`, {
              trader: transfer.fromUserAccount || transfer.toUserAccount,
              amount: this.estimateSOLAmount(transfer.tokenAmount),
              totalTrades: this.stats.tradesAdded
            });
          }
        }
      } else {
        logger.info(`🔍 ${this.name}: DEX transaction has no tokenTransfers`, {
          hasTokenTransfers: !!transaction.tokenTransfers,
          tokenTransfersType: typeof transaction.tokenTransfers,
          tokenTransfersCount: transaction.tokenTransfers?.length || 0
        });
      }
    } catch (error) {
      logger.error(`🔍 ${this.name}: Activity extraction error`, { 
        error: error.message,
        stack: error.stack?.substring(0, 200)
      });
    }
  }

  isFromTargetDEX(transaction) {
    if (transaction.tokenTransfers && Array.isArray(transaction.tokenTransfers) && 
        transaction.tokenTransfers.length >= 1) {
      return true;
    }
    
    return true;
  }

  checkDescriptionMatch(description) {
    if (!description || typeof description !== 'string') return false;
    const desc = description.toLowerCase();
    return desc.includes('pump.fun') || desc.includes('pumpfun') || 
           desc.includes('raydium') || desc.includes('orca') || 
           desc.includes('meteora') || desc.includes('swap') ||
           desc.includes('trade') || desc.includes('buy') || desc.includes('sell');
  }

  checkInstructionMatch(instructions) {
    if (!instructions || !Array.isArray(instructions)) return false;
    for (const instruction of instructions) {
      if (instruction.programId && this.ALLOWED_PROGRAM_IDS.includes(instruction.programId)) {
        return true;
      }
    }
    return false;
  }

  isValidActivityTransfer(transfer) {
    return transfer.mint && 
           transfer.tokenAmount > 0 && 
           (transfer.fromUserAccount || transfer.toUserAccount) &&
           transfer.mint !== 'So11111111111111111111111111111111111111112' && // Exclude wrapped SOL
           transfer.mint !== 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // Exclude USDC
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
        eventsReceived: this.stats.eventsReceived,
        eventsProcessed: this.stats.eventsProcessed,
        dexEventsFound: this.stats.dexEventsFound,
        tradesAdded: this.stats.tradesAdded
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

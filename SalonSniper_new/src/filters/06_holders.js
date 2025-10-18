const logger = require('../utils/logging');
const { Connection, PublicKey } = require('@solana/web3.js');

class HoldersFilter {
  constructor() {
    this.name = '06_holders';
    this.enabled = process.env.HOLDERS_ENABLED === 'true';
    this.critical = process.env.HOLDERS_CRITICAL === 'true';
    this.mode = process.env.HOLDERS_MODE || 'LOG_ONLY';
    
    this.cacheTtlMs = parseInt(process.env.HOLDERS_CACHE_TTL_MS) || 900000;
    this.rpcTimeoutMs = parseInt(process.env.HOLDERS_RPC_TIMEOUT_MS) || 1500;
    this.filterTimeoutMs = parseInt(process.env.HOLDERS_FILTER_TIMEOUT_MS) || 2500;
    this.concurrency = parseInt(process.env.HOLDERS_CONCURRENCY) || 10;
    this.rateLimitQps = parseInt(process.env.HOLDERS_RATE_LIMIT_QPS) || 40;
    this.topN = parseInt(process.env.HOLDERS_TOP_N) || 5;
    this.keepAlive = process.env.HOLDERS_KEEPALIVE === 'true';
    
    this.top1MaxPct = parseFloat(process.env.HOLDERS_TOP1_MAX_PCT) || 5;
    this.top5MaxPct = parseFloat(process.env.HOLDERS_TOP5_MAX_PCT) || 10;
    this.top10MaxPct = parseFloat(process.env.HOLDERS_TOP10_MAX_PCT) || 20;
    this.teamMaxPct = parseFloat(process.env.HOLDERS_TEAM_MAX_PCT) || 15;
    this.newWalletsWarnPct = parseFloat(process.env.HOLDERS_NEW_WALLETS_WARN_PCT) || 40;
    this.newWalletsFailPct = parseFloat(process.env.HOLDERS_NEW_WALLETS_FAIL_PCT) || 60;
    this.newWalletAgeDays = parseInt(process.env.HOLDERS_NEW_WALLET_AGE_DAYS) || 7;
    this.verifyTxHistory = process.env.HOLDERS_VERIFY_TX_HISTORY === 'true';
    
    this.connection = new Connection(process.env.HELIUS_RPC, {
      commitment: 'confirmed',
      httpHeaders: {
        'Content-Type': 'application/json'
      }
    });
    
    this.cache = new Map();
    this.requestQueue = [];
    this.activeRequests = 0;
    this.lastRequestTime = 0;
    
    this.stats = {
      totalProcessed: 0,
      totalPassed: 0,
      totalFailed: 0,
      totalWarned: 0,
      cacheHits: 0,
      cacheMisses: 0,
      rpcErrors: 0,
      timeouts: 0,
      avgProcessingTimeMs: 0,
      p95ProcessingTimeMs: 0,
      earlyBailouts: 0,
      rpcCallsPerToken: 2,
      startTime: Date.now(),
      processingTimes: []
    };
    
    this.knownContracts = new Set([
      '11111111111111111111111111111111',
      '1nc1nerator11111111111111111111111111111111',
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
      'So11111111111111111111111111111111111111112',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    ]);
    
    this.startStatsTimer();
    
    logger.info(`🔧 ${this.name}: FAST_GATE Holders Filter initialized`, {
      enabled: this.enabled,
      critical: this.critical,
      mode: this.mode,
      topN: this.topN,
      cacheTtlMin: Math.round(this.cacheTtlMs / 60000),
      rpcTimeoutMs: this.rpcTimeoutMs,
      filterTimeoutMs: this.filterTimeoutMs,
      rateLimitQps: this.rateLimitQps,
      concurrency: this.concurrency,
      keepAlive: this.keepAlive,
      thresholds: {
        top1MaxPct: this.top1MaxPct,
        top5MaxPct: this.top5MaxPct,
        top10MaxPct: this.top10MaxPct
      }
    });
  }
  
  startStatsTimer() {
    setInterval(() => {
      this.logStats();
    }, 10000);
  }
  
  logStats() {
    const runtime = Date.now() - this.stats.startTime;
    const runtimeMinutes = runtime / 60000;
    
    const statsData = {
      filter: this.name,
      enabled: this.enabled,
      mode: this.mode,
      runtime: {
        ms: runtime,
        minutes: Math.round(runtimeMinutes * 10) / 10
      },
      processing: {
        totalProcessed: this.stats.totalProcessed,
        totalPassed: this.stats.totalPassed,
        totalFailed: this.stats.totalFailed,
        totalWarned: this.stats.totalWarned,
        passRate: this.stats.totalProcessed > 0 ? 
          Math.round((this.stats.totalPassed / this.stats.totalProcessed) * 1000) / 10 + '%' : '0%',
        warnRate: this.stats.totalProcessed > 0 ? 
          Math.round((this.stats.totalWarned / this.stats.totalProcessed) * 1000) / 10 + '%' : '0%'
      },
      performance: {
        avgProcessingTimeMs: this.stats.avgProcessingTimeMs,
        cacheHitRate: (this.stats.cacheHits + this.stats.cacheMisses) > 0 ? 
          Math.round((this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses)) * 1000) / 10 + '%' : '0%',
        rpcErrors: this.stats.rpcErrors,
        timeouts: this.stats.timeouts
      },
      queue: {
        activeRequests: this.activeRequests,
        queuedRequests: this.requestQueue.length
      }
    };
    
    logger.info(`📊 ${this.name}: Statistics`, statsData);
  }
  
  async process(tokenData) {
    if (!this.enabled) {
      return this.createResult(true, 0, 'filter_disabled', 'passed');
    }
    
    const startTime = Date.now();
    this.stats.totalProcessed++;
    
    try {
      const mint = tokenData.mint;
      
      if (!this.isValidMint(mint)) {
        this.stats.totalFailed++;
        return this.createResult(false, -0.5, 'invalid_mint', 'failed', {}, startTime);
      }
      
      const cacheKey = `holders:${mint}|${this.topN}`;
      const cached = this.getFromCache(cacheKey);
      if (cached) {
        this.stats.cacheHits++;
        const result = { ...cached, usedCache: true };
        this.updateStats(result, startTime);
        return result;
      }
      
      this.stats.cacheMisses++;
      
      const analysis = await this.analyzeHolders(mint, tokenData);
      const result = this.makeDecision(analysis, startTime);
      
      this.setCache(cacheKey, result);
      this.updateStats(result, startTime);
      
      logger.info(`${result.pass ? '✅' : '❌'} ${this.name}: Token ${result.action}`, {
        mint: mint,
        signature: tokenData.signature,
        ...result
      });
      
      return result;
      
    } catch (error) {
      this.stats.totalFailed++;
      this.stats.rpcErrors++;
      
      logger.error(`💥 ${this.name}: Processing error`, {
        mint: tokenData.mint,
        signature: tokenData.signature,
        error: error.message,
        stack: error.stack
      });
      
      return this.createResult(false, -0.2, 'processing_error', 'failed', {
        error: error.message
      }, startTime);
    }
  }
  
  isValidMint(mint) {
    try {
      new PublicKey(mint);
      return true;
    } catch {
      return false;
    }
  }
  
  async analyzeHolders(mint, tokenData) {
    const analysis = {
      mint: mint,
      supply: null,
      holders: [],
      top1Pct: 0,
      top5Pct: 0,
      top10Pct: 0,
      evidence: []
    };

    try {
      const [supplyResult, holdersResult] = await Promise.all([
        this.getTokenSupply(mint),
        this.getTokenLargestAccounts(mint)
      ]);

      if (!supplyResult?.value?.uiAmount || !holdersResult?.value) {
        analysis.evidence.push('Failed to get basic token info');
        return analysis;
      }

      analysis.supply = supplyResult.value.uiAmount;
      const accounts = holdersResult.value.slice(0, this.topN);
      
      if (accounts.length > 0) {
        const top1Pct = (accounts[0].uiAmount / analysis.supply) * 100;
        if (top1Pct > this.top1MaxPct) {
          analysis.top1Pct = top1Pct;
          analysis.evidence.push(`Top1 holder: ${top1Pct.toFixed(1)}% > ${this.top1MaxPct}%`);
          return analysis; // Early exit
        }
      }

      let top5Total = 0, top10Total = 0;
      
      for (let i = 0; i < Math.min(accounts.length, 10); i++) {
        const account = accounts[i];
        const pct = (account.uiAmount / analysis.supply) * 100;
        
        analysis.holders.push({
          address: account.address,
          amount: account.uiAmount,
          percentage: pct
        });
        
        if (i < 5) top5Total += pct;
        top10Total += pct;
      }

      analysis.top1Pct = analysis.holders[0]?.percentage || 0;
      analysis.top5Pct = top5Total;
      analysis.top10Pct = top10Total;

      analysis.evidence = analysis.holders.map(h => 
        `${h.address.substring(0, 8)}...: ${h.percentage.toFixed(1)}%`
      );

      return analysis;
      
    } catch (error) {
      analysis.evidence.push(`RPC error: ${error.message}`);
      return analysis;
    }
  }
  
  shouldExcludeOwner(owner) {
    return this.knownContracts.has(owner) || 
           owner === '11111111111111111111111111111111' ||
           owner === '1nc1nerator11111111111111111111111111111111';
  }
  
  
  makeDecision(analysis, startTime) {
    let pass = true;
    let reason = 'holders_ok';
    let scoreDelta = 0;
    let action = 'passed';

    if (analysis.top1Pct > this.top1MaxPct) {
      pass = false;
      reason = 'top1_too_high';
      scoreDelta = -0.8;
      action = 'failed';
    } else if (analysis.top5Pct > this.top5MaxPct) {
      pass = false;
      reason = 'top5_too_high';
      scoreDelta = -0.6;
      action = 'failed';
    } else if (analysis.top10Pct > this.top10MaxPct) {
      pass = false;
      reason = 'top10_too_high';
      scoreDelta = -0.4;
      action = 'failed';
    } else {
      scoreDelta = 0.3;
    }

    const metrics = {
      supply: analysis.supply,
      holdersCount: analysis.holders.length,
      top1Pct: Math.round(analysis.top1Pct * 100) / 100,
      top5Pct: Math.round(analysis.top5Pct * 100) / 100,
      top10Pct: Math.round(analysis.top10Pct * 100) / 100,
      evidence: analysis.evidence
    };

    return this.createResult(pass, scoreDelta, reason, action, metrics, startTime);
  }
  
  createResult(pass, scoreDelta, reason, action, metrics = {}, startTime = Date.now()) {
    return {
      pass: pass,
      critical: this.critical,
      scoreDelta: scoreDelta,
      reason: reason,
      action: action,
      metrics: metrics,
      processingTimeMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
      usedCache: false
    };
  }
  
  updateStats(result, startTime) {
    const processingTime = Date.now() - startTime;
    this.stats.processingTimes.push(processingTime);
    
    this.stats.avgProcessingTimeMs = 
      (this.stats.avgProcessingTimeMs * (this.stats.totalProcessed - 1) + processingTime) / 
      this.stats.totalProcessed;
    
    if (this.stats.processingTimes.length >= 20) {
      const sorted = [...this.stats.processingTimes].sort((a, b) => a - b);
      this.stats.p95ProcessingTimeMs = sorted[Math.floor(sorted.length * 0.95)];
    }
    
    if (result.reason === 'top1_too_high' && result.metrics && result.metrics.evidence && result.metrics.evidence.length === 1) {
      this.stats.earlyBailouts++;
    }
    
    if (result.pass) {
      this.stats.totalPassed++;
    } else {
      this.stats.totalFailed++;
    }
    
    if (result.action === 'warn') {
      this.stats.totalWarned++;
    }
  }
  
  getFromCache(key) {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
      return cached.data;
    }
    this.cache.delete(key);
    return null;
  }
  
  setCache(key, data) {
    this.cache.set(key, {
      data: data,
      timestamp: Date.now()
    });
  }
  
  async getTokenSupply(mint) {
    const mintPubkey = new PublicKey(mint);
    return await this.makeRpcCall('getTokenSupply', [mintPubkey]);
  }
  
  async getTokenLargestAccounts(mint) {
    const mintPubkey = new PublicKey(mint);
    return await this.makeRpcCall('getTokenLargestAccounts', [mintPubkey]);
  }
  
  
  async makeRpcCall(method, params) {
    return new Promise((resolve, reject) => {
      const request = { method, params, resolve, reject };
      this.requestQueue.push(request);
      this.processQueue();
    });
  }
  
  async processQueue() {
    if (this.activeRequests >= this.concurrency || this.requestQueue.length === 0) {
      return;
    }
    
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    const minInterval = 1000 / this.rateLimitQps;
    
    if (timeSinceLastRequest < minInterval) {
      setTimeout(() => this.processQueue(), minInterval - timeSinceLastRequest);
      return;
    }
    
    const request = this.requestQueue.shift();
    this.activeRequests++;
    this.lastRequestTime = now;
    
    try {
      const result = await Promise.race([
        this.connection[request.method](...request.params),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('RPC timeout')), this.rpcTimeoutMs)
        )
      ]);
      
      request.resolve(result);
    } catch (error) {
      if (error.message === 'RPC timeout') {
        this.stats.timeouts++;
      } else {
        this.stats.rpcErrors++;
      }
      request.reject(error);
    } finally {
      this.activeRequests--;
      setTimeout(() => this.processQueue(), 50);
    }
  }
  
  getStats() {
    const cacheHitRate = this.stats.cacheHits + this.stats.cacheMisses > 0 ? 
      (this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses)) * 100 : 0;
    
    const earlyBailoutRate = this.stats.totalProcessed > 0 ? 
      (this.stats.earlyBailouts / this.stats.totalProcessed) * 100 : 0;
    
    return {
      ...this.stats,
      enabled: this.enabled,
      mode: this.mode,
      cacheSize: this.cache.size,
      queueLength: this.requestQueue.length,
      activeRequests: this.activeRequests,
      holdersLatencyMsAvg: Math.round(this.stats.avgProcessingTimeMs),
      holdersLatencyMsP95: Math.round(this.stats.p95ProcessingTimeMs),
      holdersRpcCallsPerToken: this.stats.rpcCallsPerToken,
      holdersCacheHitPct: Math.round(cacheHitRate * 100) / 100,
      holdersEarlyBailoutPct: Math.round(earlyBailoutRate * 100) / 100
    };
  }
  
  updateConfig(newConfig) {
    if (newConfig.HOLDERS_ENABLED !== undefined) {
      this.enabled = newConfig.HOLDERS_ENABLED === 'true';
    }
    if (newConfig.HOLDERS_MODE !== undefined) {
      this.mode = newConfig.HOLDERS_MODE;
    }
    if (newConfig.HOLDERS_TOP1_MAX_PCT !== undefined) {
      this.top1MaxPct = parseFloat(newConfig.HOLDERS_TOP1_MAX_PCT);
    }
    if (newConfig.HOLDERS_TOP5_MAX_PCT !== undefined) {
      this.top5MaxPct = parseFloat(newConfig.HOLDERS_TOP5_MAX_PCT);
    }
    if (newConfig.HOLDERS_TOP10_MAX_PCT !== undefined) {
      this.top10MaxPct = parseFloat(newConfig.HOLDERS_TOP10_MAX_PCT);
    }
    
    logger.info(`🔧 ${this.name}: Configuration updated`, {
      enabled: this.enabled,
      mode: this.mode,
      thresholds: {
        top1MaxPct: this.top1MaxPct,
        top5MaxPct: this.top5MaxPct,
        top10MaxPct: this.top10MaxPct
      }
    });
  }
}

module.exports = HoldersFilter;


const { Connection, PublicKey } = require('@solana/web3.js');
const logger = require('../utils/logging');
const { getJupiterQuoteUrl, getJupiterHeaders, getJupiterConfig } = require('../config/jupiterConfig');

class LPProtectionFilter {
  constructor() {
    this.name = '06_lpProtection';
    this.enabled = process.env.LP_PROTECTION_ENABLED === 'true';
    this.mode = process.env.LP_PROTECTION_MODE || 'SAFE';
    
    this.top1Max = parseFloat(process.env.LP_TOP1_MAX) || 50;
    this.top5Max = parseFloat(process.env.LP_TOP5_MAX) || 80;
    this.burnMinPct = parseFloat(process.env.LP_BURN_MIN_PCT) || 80;
    
    const lockerWhitelist = process.env.LP_LOCKER_WHITELIST || '';
    this.lockerWhitelist = new Set(lockerWhitelist.split(',').filter(addr => addr.trim()));
    
    const piTestAmounts = process.env.LP_PI_TEST_AMOUNTS || '0.02,0.5';
    this.piTestAmounts = piTestAmounts.split(',').map(amt => parseFloat(amt.trim()));
    this.piDeltaMaxBps = parseFloat(process.env.LP_PI_DELTA_MAX_BPS) || 500;
    
    // Используем единый конфиг Jupiter
    const jupiterConfig = getJupiterConfig();
    this.jupiterConfig = {
      baseUrl: jupiterConfig.quoteUrl.split('/swap/v1/quote')[0], // извлекаем хост из полного URL
      quotePath: '/swap/v1/quote',
      apiKey: jupiterConfig.apiKey,
      fallbackUrl: null, // no fallback for LITE mode
      outputMint: process.env.JUP_OUTPUT_MINT || 'So11111111111111111111111111111111111111112',
      slippageBps: parseInt(process.env.JUP_SLIPPAGE_BPS) || 50,
      rateLimitRps: parseFloat(process.env.JUP_RATE_LIMIT_RPS) || 2,
      concurrency: parseInt(process.env.JUP_CONCURRENCY) || 2,
      cacheTtlMs: parseInt(process.env.JUP_CACHE_TTL_MS) || 60000,
      timeoutMs: parseInt(process.env.JUP_TIMEOUT_MS) || 2500,
      retry: parseInt(process.env.JUP_RETRY) || 2
    };
    
    this.rpcUrl = process.env.HELIUS_RPC;
    this.connection = new Connection(this.rpcUrl, 'confirmed');
    
    this.incinerator = '1nc1nerator11111111111111111111111111111111';
    
    this.requestQueue = [];
    this.activeRequests = 0;
    this.lastRequestTime = 0;
    this.cache = new Map();
    
    this.stats = {
      processed: 0,
      by_branch: {
        bonding_curve: 0,
        cpmm: 0,
        clmm_dlmm: 0
      },
      decisions: {
        passed: 0,
        warn: 0,
        failed: 0,
        pass_log_only: 0
      },
      avg_latency_ms: 0,
      jup_requests: 0,
      jup_errors: 0,
      jupiter429: 0,
      rpc_requests: 0,
      rpc_errors: 0,
      cache_hits: 0,
      startTime: Date.now()
    };
    
    this.startStatsTimer();
    this.startRequestProcessor();
    
    logger.info(`🛡️ ${this.name}: LP Protection Filter initialized (DEX-aware)`, {
      enabled: this.enabled,
      mode: this.mode,
      top1Max: this.top1Max,
      top5Max: this.top5Max,
      burnMinPct: this.burnMinPct,
      lockerWhitelist: this.lockerWhitelist.size,
      piTestAmounts: this.piTestAmounts,
      piDeltaMaxBps: this.piDeltaMaxBps,
      jupiterConfig: {
        baseUrl: this.jupiterConfig.baseUrl,
        rateLimitRps: this.jupiterConfig.rateLimitRps,
        concurrency: this.jupiterConfig.concurrency
      }
    });
  }
  
  startStatsTimer() {
    setInterval(() => {
      this.logStats();
    }, 60000);
  }
  
  startRequestProcessor() {
    setInterval(() => {
      this.processRequestQueue();
    }, 100);
  }
  
  async processRequestQueue() {
    if (this.requestQueue.length === 0 || this.activeRequests >= this.jupiterConfig.concurrency) {
      return;
    }
    
    const now = Date.now();
    const minInterval = 1000 / this.jupiterConfig.rateLimitRps;
    
    if (now - this.lastRequestTime < minInterval) {
      return;
    }
    
    const request = this.requestQueue.shift();
    if (!request) return;
    
    this.activeRequests++;
    this.lastRequestTime = now;
    
    try {
      const result = await this.makeJupiterRequest(request.url);
      request.resolve(result);
    } catch (error) {
      request.reject(error);
    } finally {
      this.activeRequests--;
    }
  }
  
  async makeJupiterRequest(url) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.jupiterConfig.timeoutMs);
    
    try {
      const headers = getJupiterHeaders();
      
      logger.debug(`[06] JupiterRequestURL=${url}`);
      
      const response = await fetch(url, {
        signal: controller.signal,
        headers: headers
      });
      
      logger.debug(`[06] JupiterStatus=${response.status}`);
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`Jupiter API error: ${response.status} ${response.statusText}`);
      }
      
      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }
  
  async queueJupiterRequest(url) {
    return new Promise((resolve, reject) => {
      this.requestQueue.push({ url, resolve, reject });
    });
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
      stats: {
        processed: this.stats.processed,
        by_branch: this.stats.by_branch,
        decisions: this.stats.decisions,
        avg_latency_ms: this.stats.avg_latency_ms,
        jup_requests: this.stats.jup_requests,
        jup_errors: this.stats.jup_errors,
        rpc_requests: this.stats.rpc_requests,
        rpc_errors: this.stats.rpc_errors,
        cache_hits: this.stats.cache_hits
      },
      throughput: {
        tokensPerMinute: runtimeMinutes > 0 ? 
          Math.round((this.stats.processed / runtimeMinutes) * 10) / 10 : 0
      }
    };
    
    logger.info(`📊 ${this.name}: Statistics Update`, statsData);
  }
  
  async process(tokenData) {
    console.log('-> entered 3.6 (LPProtection)');
    
    if (!this.enabled) {
      console.log('<- exited 3.6 (LPProtection) - disabled');
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
    
    const { mint, signature, from3_5 = {} } = tokenData;
    
    try {
      let marketLabel = from3_5.marketLabel;
      
      if (!marketLabel) {
        marketLabel = await this.detectMarketLabel(mint);
      }
      
      const branch = this.determineBranch(marketLabel);
      this.stats.by_branch[branch]++;
      
      let result;
      
      switch (branch) {
        case 'bonding_curve':
          result = await this.processBondingCurve(mint, marketLabel);
          break;
        case 'cpmm':
          result = await this.processCPMM(mint, marketLabel, from3_5.ammKey);
          break;
        case 'clmm_dlmm':
          result = await this.processCLMM_DLMM(mint, marketLabel);
          break;
        default:
          result = this.createResult(true, 0, 'unknown_branch', 'pass_log_only', {
            branch: 'unknown',
            marketLabel: marketLabel
          });
      }
      
      result.meta.branch = branch;
      result.meta.marketLabel = marketLabel;
      result.processingTimeMs = Date.now() - startTime;
      
      this.updateStats(result);
      
      logger.info(`${this.getResultIcon(result)} ${this.name}: Token processed`, {
        mint,
        signature,
        ...result
      });
      
      console.log('<- exited 3.6 (LPProtection)');
      return result;
      
    } catch (error) {
      const result = this.createResult(true, 0, 'processing_error', 'pass_log_only', {
        error: error.message
      });
      
      result.processingTimeMs = Date.now() - startTime;
      this.stats.decisions.pass_log_only++;
      
      logger.error(`💥 ${this.name}: Processing error`, {
        mint,
        signature,
        error: error.message,
        ...result
      });
      
      console.log('<- exited 3.6 (LPProtection) - error');
      return result;
    }
  }
  
  determineBranch(marketLabel) {
    if (!marketLabel) return 'unknown';
    
    const label = marketLabel.toLowerCase();
    
    if (label.includes('pump') || label.includes('moonshot')) {
      return 'bonding_curve';
    } else if (label.includes('clmm') || label.includes('dlmm') || label.includes('meteora')) {
      return 'clmm_dlmm';
    } else if (label.includes('raydium')) {
      return 'cpmm';
    }
    
    return 'unknown';
  }
  
  async detectMarketLabel(mint) {
    try {
      const cacheKey = `market_label_${mint}`;
      const cached = this.getCachedResult(cacheKey);
      if (cached) {
        this.stats.cache_hits++;
        return cached.marketLabel;
      }
      
      const smallAmount = Math.floor(this.piTestAmounts[0] * 1e9);
      const fullUrl = getJupiterQuoteUrl();
      const url = `${fullUrl}?` +
        `inputMint=${mint}&` +
        `outputMint=${this.jupiterConfig.outputMint}&` +
        `amount=${smallAmount}&` +
        `slippageBps=${this.jupiterConfig.slippageBps}&` +
        `restrictIntermediateTokens=true`;
      
      this.stats.jup_requests++;
      const response = await this.queueJupiterRequest(url);
      
      let marketLabel = 'Unknown';
      if (response && response.routePlan && response.routePlan.length > 0) {
        const firstSwap = response.routePlan[0];
        if (firstSwap && firstSwap.swapInfo && firstSwap.swapInfo.label) {
          marketLabel = firstSwap.swapInfo.label;
        }
      }
      
      this.setCachedResult(cacheKey, { marketLabel }, this.jupiterConfig.cacheTtlMs);
      return marketLabel;
      
    } catch (error) {
      this.stats.jup_errors++;
      logger.error(`💥 ${this.name}: Market label detection error`, {
        mint,
        error: error.message
      });
      return 'Unknown';
    }
  }
  
  async processBondingCurve(mint, marketLabel) {
    try {
      // Получаем price impact для small и big сумм
      const [piSmall, piBig] = await Promise.all([
        this.getPriceImpact(mint, this.piTestAmounts[0]),
        this.getPriceImpact(mint, this.piTestAmounts[1])
      ]);
      
      if (!piSmall || !piBig) {
        return this.createResult(true, 0, 'price_impact_failed', 'pass_log_only', {
          lp_model: 'bonding_curve',
          marketLabel: marketLabel
        });
      }
      
      const deltaBps = Math.abs(piBig - piSmall);
      const isHighDelta = deltaBps > this.piDeltaMaxBps;
      
      let reason = 'bonding_curve_normal';
      let action = 'passed';
      let scoreDelta = 0;
      
      if (isHighDelta) {
        reason = 'bonding_curve_high_delta';
        action = this.mode === 'LOG_ONLY' ? 'pass_log_only' : 'warn';
        scoreDelta = -0.2;
      }
      
      return this.createResult(true, scoreDelta, reason, action, {
        lp_model: 'bonding_curve',
        marketLabel: marketLabel,
        pi_small_bps: piSmall,
        pi_big_bps: piBig,
        delta_bps: deltaBps,
        isHighDelta: isHighDelta
      });
      
    } catch (error) {
      logger.warn(`${this.name}: Bonding curve analysis failed`, {
        mint,
        error: error.message
      });
      
      return this.createResult(true, 0, 'bonding_curve_error', 'pass_log_only', {
        lp_model: 'bonding_curve',
        marketLabel: marketLabel,
        error: error.message
      });
    }
  }
  
  async processCPMM(mint, marketLabel, ammKey) {
    try {
      let lpMint = null;
      
      if (ammKey) {
        lpMint = await this.getLPMintFromAMM(ammKey);
      }
      
      if (!lpMint) {
        return this.createResult(true, 0, 'lp_lookup_failed', 'pass_log_only', {
          lp_model: 'cpmm'
        });
      }
      
      this.stats.rpc_requests++;
      const largestAccounts = await this.connection.getTokenLargestAccounts(new PublicKey(lpMint));
      
      if (!largestAccounts?.value || largestAccounts.value.length === 0) {
        this.stats.rpc_errors++;
        return this.createResult(true, 0, 'lp_accounts_failed', 'pass_log_only', {
          lp_model: 'cpmm',
          lpMint: lpMint
        });
      }
      
      const accounts = largestAccounts.value;
      const totalSupply = accounts.reduce((sum, acc) => sum + parseFloat(acc.amount), 0);
      
      const top1Amount = parseFloat(accounts[0].amount);
      const top5Amount = accounts.slice(0, 5).reduce((sum, acc) => sum + parseFloat(acc.amount), 0);
      
      const top1Pct = (top1Amount / totalSupply) * 100;
      const top5Pct = (top5Amount / totalSupply) * 100;
      
      const top1Address = accounts[0].address;
      
      let lpStatus = 'concentrated';
      let decision = 'pass';
      let scoreDelta = 0;
      let reason = 'lp_normal';
      
      if (top1Address === this.incinerator) {
        lpStatus = 'burned';
        decision = 'pass';
        scoreDelta = 0.2;
        reason = 'lp_burned';
      } else if (this.lockerWhitelist.has(top1Address)) {
        lpStatus = 'locked';
        decision = 'pass';
        scoreDelta = 0.2;
        reason = 'lp_locked';
      } else if (top1Pct > this.top1Max || top5Pct > this.top5Max) {
        lpStatus = 'concentrated';
        if (this.mode === 'STRICT') {
          decision = 'failed';
          scoreDelta = -0.8;
          reason = 'lp_concentrated';
        } else {
          decision = 'warn';
          scoreDelta = -0.1;
          reason = 'lp_concentrated';
        }
      }
      
      return this.createResult(
        decision === 'pass' || decision === 'warn',
        scoreDelta,
        reason,
        decision,
        {
          lp_model: 'cpmm',
          lpMint: lpMint,
          top1_pct: Math.round(top1Pct * 100) / 100,
          top5_pct: Math.round(top5Pct * 100) / 100,
          lp_status: lpStatus,
          locker_hit: this.lockerWhitelist.has(top1Address)
        }
      );
      
    } catch (error) {
      this.stats.rpc_errors++;
      return this.createResult(true, 0, 'cpmm_analysis_error', 'pass_log_only', {
        lp_model: 'cpmm',
        error: error.message
      });
    }
  }
  
  async processCLMM_DLMM(mint, marketLabel) {
    try {
      const [smallAmount, bigAmount] = this.piTestAmounts.map(amt => Math.floor(amt * 1e9));
      
      const [smallQuote, bigQuote] = await Promise.all([
        this.getJupiterQuote(mint, smallAmount),
        this.getJupiterQuote(mint, bigAmount)
      ]);
      
      if (!smallQuote || !bigQuote) {
        return this.createResult(true, 0, 'clmm_quote_failed', 'pass_log_only', {
          lp_model: 'clmm_dlmm'
        });
      }
      
      const piSmallBps = smallQuote.priceImpactPct ? Math.round(smallQuote.priceImpactPct * 10000) : 0;
      const piBigBps = bigQuote.priceImpactPct ? Math.round(bigQuote.priceImpactPct * 10000) : 0;
      const deltaBps = piBigBps - piSmallBps;
      
      let lpRisk = 'normal';
      let decision = 'pass';
      let scoreDelta = 0;
      let reason = 'clmm_normal';
      
      if (deltaBps > this.piDeltaMaxBps) {
        lpRisk = 'high';
        decision = 'warn';
        scoreDelta = -0.1;
        reason = 'clmm_delta_high';
      }
      
      return this.createResult(true, scoreDelta, reason, decision, {
        lp_model: 'clmm_dlmm',
        pi_small_bps: piSmallBps,
        pi_big_bps: piBigBps,
        delta_bps: deltaBps,
        lp_risk: lpRisk
      });
      
    } catch (error) {
      this.stats.jup_errors++;
      return this.createResult(true, 0, 'clmm_analysis_error', 'pass_log_only', {
        lp_model: 'clmm_dlmm',
        error: error.message
      });
    }
  }
  
  async getJupiterQuote(mint, amount) {
    try {
      const cacheKey = `quote_${mint}_${amount}`;
      const cached = this.getCachedResult(cacheKey);
      if (cached) {
        this.stats.cache_hits++;
        return cached;
      }
      
      const fullUrl = getJupiterQuoteUrl();
      const url = `${fullUrl}?` +
        `inputMint=${mint}&` +
        `outputMint=${this.jupiterConfig.outputMint}&` +
        `amount=${amount}&` +
        `slippageBps=${this.jupiterConfig.slippageBps}&` +
        `restrictIntermediateTokens=true`;
      
      this.stats.jup_requests++;
      const response = await this.queueJupiterRequest(url);
      
      this.setCachedResult(cacheKey, response, this.jupiterConfig.cacheTtlMs);
      return response;
      
    } catch (error) {
      this.stats.jup_errors++;
      throw error;
    }
  }
  
  async getLPMintFromAMM(ammKey) {
    try {
      this.stats.rpc_requests++;
      const accountInfo = await this.connection.getAccountInfo(new PublicKey(ammKey));
      
      if (!accountInfo || !accountInfo.data || accountInfo.data.length < 752) {
        return null;
      }
      
      const lpMintBytes = accountInfo.data.slice(400, 432);
      return new PublicKey(lpMintBytes).toString();
      
    } catch (error) {
      this.stats.rpc_errors++;
      return null;
    }
  }
  
  createResult(pass, scoreDelta, reason, action, meta = {}) {
    return {
      pass: pass,
      critical: false,
      scoreDelta: scoreDelta,
      reason: reason,
      action: action,
      meta: meta
    };
  }
  
  updateStats(result) {
    this.stats.decisions[result.action]++;
    
    if (result.processingTimeMs) {
      const currentAvg = this.stats.avg_latency_ms;
      const count = this.stats.processed;
      this.stats.avg_latency_ms = Math.round(
        ((currentAvg * (count - 1)) + result.processingTimeMs) / count
      );
    }
  }
  
  getResultIcon(result) {
    switch (result.action) {
      case 'passed': return '✅';
      case 'warn': return '⚠️';
      case 'failed': return '❌';
      case 'pass_log_only': return '📝';
      default: return '❓';
    }
  }
  
  getCachedResult(key) {
    const cached = this.cache.get(key);
    if (!cached) return null;
    
    if (Date.now() > cached.expiry) {
      this.cache.delete(key);
      return null;
    }
    
    return cached.data;
  }
  
  setCachedResult(key, data, ttlMs) {
    this.cache.set(key, {
      data: data,
      expiry: Date.now() + ttlMs
    });
  }
  
  async getPriceImpact(mint, amountSOL) {
    try {
      const cacheKey = `price_impact_${mint}_${amountSOL}`;
      const cached = this.getCachedResult(cacheKey);
      if (cached) {
        this.stats.cache_hits++;
        return cached;
      }
      
      this.stats.cache_hits--;
      this.stats.jupiterRequests++;
      
      const amountLamports = Math.floor(amountSOL * 1e9);
      const fullUrl = getJupiterQuoteUrl();
      const url = new URL(fullUrl);
      url.searchParams.set('inputMint', mint);
      url.searchParams.set('outputMint', this.jupiterConfig.outputMint);
      url.searchParams.set('amount', amountLamports.toString());
      url.searchParams.set('slippageBps', this.jupiterConfig.slippageBps.toString());
      
      const headers = getJupiterHeaders();
      
      logger.debug(`[06] JupiterRequestURL=${url.toString()}`);
      
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: headers,
        timeout: this.jupiterConfig.timeoutMs
      });
      
      logger.debug(`[06] JupiterStatus=${response.status}`);
      
      if (!response.ok) {
        if (response.status === 429) {
          this.stats.jupiter429++;
        } else {
          this.stats.jupiterErrors++;
        }
        return null;
      }
      
      const data = await response.json();
      
      if (!data?.data?.[0]) {
        return null;
      }
      
      const priceImpactBps = Math.round((data.data[0].priceImpactPct || 0) * 100);
      
      this.setCachedResult(cacheKey, priceImpactBps, this.jupiterConfig.cacheTtlMs);
      
      return priceImpactBps;
      
    } catch (error) {
      this.stats.jupiterErrors++;
      logger.warn(`${this.name}: Price impact request failed`, {
        mint,
        amountSOL,
        error: error.message
      });
      return null;
    }
  }
  
  getStats() {
    return {
      ...this.stats,
      enabled: this.enabled,
      mode: this.mode,
      cacheSize: this.cache.size,
      queueSize: this.requestQueue.length,
      activeRequests: this.activeRequests
    };
  }
}

module.exports = LPProtectionFilter;

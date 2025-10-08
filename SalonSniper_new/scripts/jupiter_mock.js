// 🧪 Mock Jupiter API для тестирования фильтров 3.5-3.7
// Используется когда реальный Jupiter API недоступен

const fetch = require("node-fetch").default;

class JupiterMock {
  constructor() {
    this.baseUrl = "https://quote-api.jup.ag";
    this.mockData = {
      priceImpactBps: Math.floor(Math.random() * 500) + 50, // 50-550 bps
      platforms: ["Raydium", "Orca", "Serum", "Meteora"],
      routeExists: true,
      el_sol: Math.random() * 2 + 0.1, // 0.1-2.1 SOL
      branch: ["bonding_curve", "clmm_dlmm", "cpmm"][Math.floor(Math.random() * 3)]
    };
  }

  async getQuote(inputMint, outputMint, amount) {
    // Имитируем задержку API
    await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 200));
    
    // Генерируем реалистичные данные
    const priceImpactBps = this.mockData.priceImpactBps;
    const platform = this.mockData.platforms[Math.floor(Math.random() * this.mockData.platforms.length)];
    const el_sol = this.mockData.el_sol;
    const branch = this.mockData.branch;
    
    return {
      data: [{
        priceImpactPct: priceImpactBps / 10000,
        platform: platform,
        routePlan: [{
          swapInfo: {
            ammKey: "mock_amm_key",
            label: platform
          }
        }]
      }],
      inputMint: inputMint,
      outputMint: outputMint,
      amount: amount,
      mock: true
    };
  }

  async testConnection() {
    try {
      const quote = await this.getQuote(
        "So11111111111111111111111111111111111111112",
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        10000000
      );
      
      console.log("✅ Jupiter Mock API работает!");
      console.log("📊 Тестовые данные:", {
        priceImpactBps: Math.round(quote.data[0].priceImpactPct * 10000),
        platform: quote.data[0].platform,
        el_sol: this.mockData.el_sol,
        branch: this.mockData.branch
      });
      
      return true;
    } catch (error) {
      console.error("❌ Jupiter Mock API ошибка:", error.message);
      return false;
    }
  }
}

module.exports = JupiterMock;

// Тест при прямом запуске
if (require.main === module) {
  const mock = new JupiterMock();
  mock.testConnection();
}

/**
 * Jupiter API Configuration Module
 * Единый конфиг для всех фильтров 3.5-3.7
 * Поддерживает Lite (без ключа) и Pro (с ключом) планы
 */

// Безопасная загрузка dotenv (грузится единожды и очень рано)
if (!process.env.DOTENV_LOADED) {
  require('dotenv').config();
  process.env.DOTENV_LOADED = 'true';
}

/**
 * Получить URL для Jupiter Quote API
 * @returns {string} URL для запросов к Jupiter API
 */
function getJupiterQuoteUrl() {
  const plan = process.env.JUPITER_PLAN || 'lite';
  const apiKey = process.env.JUPITER_API_KEY || '';
  
  // Если план Pro и есть ключ - используем Pro URL
  if (plan === 'pro' && apiKey.trim()) {
    return process.env.JUPITER_QUOTE_URL_PRO || 'https://api.jup.ag/swap/v1/quote';
  }
  
  // Иначе используем Lite URL
  return process.env.JUPITER_QUOTE_URL_LITE || 'https://lite-api.jup.ag/swap/v1/quote';
}

/**
 * Получить заголовки для Jupiter API
 * @returns {object} Заголовки для HTTP запросов
 */
function getJupiterHeaders() {
  const headers = {
    'accept': 'application/json',
    'User-Agent': 'SalonSniper/1.0'
  };
  
  const plan = process.env.JUPITER_PLAN || 'lite';
  const apiKey = process.env.JUPITER_API_KEY || '';
  
  // Если план Pro и есть ключ - добавляем x-api-key
  if (plan === 'pro' && apiKey.trim()) {
    headers['x-api-key'] = apiKey;
  }
  
  return headers;
}

/**
 * Получить конфигурацию Jupiter API
 * @returns {object} Полная конфигурация
 */
function getJupiterConfig() {
  const plan = process.env.JUPITER_PLAN || 'lite';
  const apiKey = process.env.JUPITER_API_KEY || '';
  
  return {
    plan,
    apiKey,
    quoteUrl: getJupiterQuoteUrl(),
    headers: getJupiterHeaders(),
    timeout: parseInt(process.env.JUPITER_REQUEST_TIMEOUT_MS) || 4000,
    retries: parseInt(process.env.JUPITER_RETRIES) || 2,
    concurrency: parseInt(process.env.JUPITER_REQUEST_CONCURRENCY) || 2,
    useMock: process.env.JUPITER_USE_MOCK === 'true'
  };
}

/**
 * Проверить, что мок отключен
 * @returns {boolean} true если мок отключен
 */
function isMockDisabled() {
  return process.env.JUPITER_USE_MOCK !== 'true';
}

/**
 * Получить fallback URL (для обратной совместимости)
 * @returns {string} Fallback URL
 */
function getJupiterFallbackUrl() {
  // Сначала проверяем новые переменные
  const liteUrl = process.env.JUPITER_QUOTE_URL_LITE;
  const proUrl = process.env.JUPITER_QUOTE_URL_PRO;
  
  if (liteUrl && proUrl) {
    return liteUrl; // Используем Lite как fallback
  }
  
  // Fallback на старые переменные (для обратной совместимости)
  const oldUrl = process.env.JUPITER_QUOTE_URL;
  if (oldUrl) {
    console.warn('⚠️  Используется устаревшая переменная JUPITER_QUOTE_URL. Рекомендуется использовать JUPITER_QUOTE_URL_LITE/PRO');
    return oldUrl;
  }
  
  // Дефолтный fallback
  return 'https://lite-api.jup.ag/swap/v1/quote';
}

module.exports = {
  getJupiterQuoteUrl,
  getJupiterHeaders,
  getJupiterConfig,
  isMockDisabled,
  getJupiterFallbackUrl
};


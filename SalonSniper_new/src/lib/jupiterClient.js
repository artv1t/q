/**
 * Jupiter API Client
 * Единый клиент для всех фильтров 3.5-3.7
 */

export async function jupFetch(url, { signal } = {}) {
  const u = new URL(url);
  const key = process.env.JUPITER_API_KEY || '';
  
  const res = await fetch(u.toString(), {
    method: 'GET',
    headers: { 
      'accept': 'application/json', 
      ...(key ? {'x-api-key': key} : {}) 
    },
    signal
  });
  
  return res;
}

export function getJupiterConfig() {
  return {
    quoteUrl: process.env.JUPITER_QUOTE_URL || 'https://api.jup.ag/v6/quote',
    fallbackUrl: process.env.JUPITER_QUOTE_URL_V4 || 'https://api.jup.ag/v4/quote',
    apiKey: process.env.JUPITER_API_KEY || '',
    timeout: parseInt(process.env.JUPITER_REQUEST_TIMEOUT_MS) || 4000,
    useMock: process.env.JUPITER_USE_MOCK === 'true'
  };
}


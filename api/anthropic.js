export const maxDuration = 60;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  const MAX_RETRIES = 3;
  const requestBody = JSON.stringify(req.body);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'web-search-2025-03-05,prompt-caching-2024-07-31',
        },
        body: requestBody,
      });

      // Retry on 429 (rate limit) or 529 (overloaded) with exponential backoff
      if ((response.status === 429 || response.status === 529) && attempt < MAX_RETRIES) {
        const retryAfter = response.headers.get('retry-after');
        const waitMs = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : Math.min(1000 * Math.pow(2, attempt), 15000);   // 1s, 2s, 4s
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }

      const data = await response.json();
      return res.status(response.status).json(data);
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
        continue;
      }
      return res.status(500).json({ error: err.message });
    }
  }
}

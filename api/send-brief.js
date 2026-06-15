export const maxDuration = 30;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const resendKey = process.env.RESEND_API_KEY;
  const recipients = (process.env.BRIEF_RECIPIENT_EMAIL || '').split(',').map(s => s.trim()).filter(Boolean);

  if (!resendKey) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });
  if (recipients.length === 0) return res.status(500).json({ error: 'BRIEF_RECIPIENT_EMAIL not configured' });

  const { subject, html } = req.body;
  if (!subject || !html) {
    return res.status(400).json({ error: 'Missing required fields: subject, html' });
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from: process.env.BRIEF_FROM_EMAIL || 'Intelligence Hub <onboarding@resend.dev>',
        to: recipients,
        subject,
        html,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.message || 'Resend API error',
        details: data,
      });
    }

    return res.status(200).json({ success: true, id: data.id });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

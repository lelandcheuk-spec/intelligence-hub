#!/usr/bin/env node
/**
 * Weekly Intelligence Hub brief — unattended pipeline.
 *
 * Runs the full agent pipeline server-side and emails the result via Resend:
 *   3 listening sweeps (parallel) → synthesis → content strategy → campaign → verticals → email
 *
 * Designed to run from GitHub Actions on a weekly schedule (Mondays, 8am Pacific).
 * The schedule fires at two UTC slots to cover DST; this script only proceeds when
 * it is actually 08:xx Monday in America/Los_Angeles (or when FORCE_RUN=true).
 *
 * Required env: ANTHROPIC_API_KEY, RESEND_API_KEY, BRIEF_RECIPIENT_EMAIL
 * Optional env: BRIEF_FROM_EMAIL, FORCE_RUN ("true" to skip the time guard)
 */

const MODEL = 'claude-sonnet-4-5';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const RESEND_URL = 'https://api.resend.com/emails';

/* ── Time guard: only run at 08:xx Monday Pacific unless forced ── */
function pacificNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', hour12: false,
  }).formatToParts(new Date());
  const weekday = parts.find(p => p.type === 'weekday').value;
  let hour = parseInt(parts.find(p => p.type === 'hour').value, 10);
  if (hour === 24) hour = 0; // some ICU builds report midnight as 24
  return { weekday, hour };
}

/* ── Anthropic call with retry + web_search pause_turn continuation ── */
async function callModel({ system, tools, maxTokens = 8192, userText }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'web-search-2025-03-05,prompt-caching-2024-07-31',
  };

  const messages = [{ role: 'user', content: userText }];
  let allText = '';

  // Up to 4 turns to absorb web_search pause_turn cycles.
  for (let turn = 0; turn < 4; turn++) {
    const body = {
      model: MODEL,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages,
    };
    if (tools) body.tools = tools;

    let data;
    for (let attempt = 0; attempt <= 3; attempt++) {
      const resp = await fetch(ANTHROPIC_URL, { method: 'POST', headers, body: JSON.stringify(body) });
      if ((resp.status === 429 || resp.status === 529) && attempt < 3) {
        const retryAfter = resp.headers.get('retry-after');
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : Math.min(1000 * 2 ** attempt, 15000);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      data = await resp.json();
      if (!resp.ok) throw new Error(`API error ${resp.status}: ${data.error ? data.error.message : JSON.stringify(data)}`);
      break;
    }

    allText += (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');

    if (data.stop_reason === 'pause_turn') {
      // Server-side tool loop paused — append assistant turn and continue.
      messages.push({ role: 'assistant', content: data.content });
      continue;
    }
    break;
  }
  return allText;
}

function parseJson(text) {
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    const match = clean.match(/\{[\s\S]*\}/);
    return JSON.parse(match ? match[0] : clean);
  } catch (e) {
    return null;
  }
}

/* ════════════ AGENT PROMPTS (full default scope, 14-day windows) ════════════ */

const CUSTOMER_SYSTEM = `You are an independent market research analyst monitoring enterprise IT decision-maker sentiment. Report what buyers are actually saying in their own words — not what any vendor wants to hear.

Scan for signals from: CIO, CTO, Head of Infrastructure, Head of Cloud / Cloud Center of Excellence, Head of Networking, Head of AI / Data Analytics.

Search these sources: LinkedIn posts, earnings calls, event sessions, trade press interviews, Reddit / HN.

Focus on: AI infrastructure priorities, cloud repatriation and cost frustration, network complexity and latency, data sovereignty and compliance, build vs. buy vs. partner for private infrastructure.

IMPORTANT: Only surface signals from the past 14 days. Ignore anything older.
IMPORTANT: Keep each JSON field to 1-2 concise sentences maximum. Be specific but brief.
IMPORTANT: Use the language buyers actually use — not vendor marketing language. Do NOT use Equinix product names, branded terms, or jargon from Equinix.com. Report raw market sentiment honestly, including frustrations with all vendors including Equinix.
IMPORTANT: For each signal, include a "source" (publication or platform name) and "url" (the actual URL where you found it). Only cite real, verifiable sources.

Return ONLY valid JSON (no markdown, no explanation):
{
  "top_signals": [
    {"persona": "CIO", "signal": "...", "implication": "...", "source": "...", "url": "..."},
    {"persona": "Head of AI / Data", "signal": "...", "implication": "...", "source": "...", "url": "..."},
    {"persona": "Head of Cloud", "signal": "...", "implication": "...", "source": "...", "url": "..."},
    {"persona": "CTO", "signal": "...", "implication": "...", "source": "...", "url": "..."},
    {"persona": "Head of Networking", "signal": "...", "implication": "...", "source": "...", "url": "..."},
    {"persona": "Head of Infrastructure", "signal": "...", "implication": "...", "source": "...", "url": "..."}
  ],
  "emerging_theme": "One sentence on the dominant cross-persona theme right now."
}`;

const COMPETITIVE_SYSTEM = `You are an independent competitive intelligence analyst covering the digital infrastructure market. Report objectively on what competitors are actually doing — not through the lens of any single vendor.

Analyze recent moves from these companies:
- Data center: Digital Realty, CoreSite, CyrusOne, Iron Mountain DC
- Cloud: AWS, GCP, Azure, Oracle Cloud
- NaaS: Megaport, PacketFabric, Lumen/Alkira
- Neocloud: CoreWeave, Nebius, Lambda Labs, Crusoe

For each tier: what did they actually announce or do, what is the market reading into it, what real risk does this pose to incumbent colocation/interconnection providers, and what gap does it expose.

IMPORTANT: Only surface moves from the past 14 days. Ignore anything older.
IMPORTANT: Keep each JSON field to 1-2 concise sentences maximum. Be specific but brief.
IMPORTANT: Use neutral industry language — not any vendor's branded terms or marketing jargon. Report competitor strengths honestly, not dismissively. Include a credible source and URL for each tier.

Return ONLY valid JSON (no markdown, no explanation):
{
  "tiers": [
    {"tier": "Data center", "key_move": "...", "market_risk": "...", "gap_exposed": "...", "source": "...", "url": "..."},
    {"tier": "Cloud", "key_move": "...", "market_risk": "...", "gap_exposed": "...", "source": "...", "url": "..."},
    {"tier": "NaaS", "key_move": "...", "market_risk": "...", "gap_exposed": "...", "source": "...", "url": "..."},
    {"tier": "Neocloud", "key_move": "...", "market_risk": "...", "gap_exposed": "...", "source": "...", "url": "..."}
  ],
  "headline_vulnerability": "The single biggest competitive threat to incumbent colocation providers right now, in one sentence."
}`;

const MEDIA_SYSTEM = `You are an independent media and analyst intelligence monitor. Report what analysts and journalists are actually writing — not what any vendor wants them to say.

Scan recent coverage from: Gartner, Forrester, IDC, 451 Research, Omdia, Network World, CIO.com, The Register, TechTarget, Data Center Knowledge.

Track: AI infrastructure, digital sovereignty and data residency, enterprise networking and security, hybrid multicloud, private infrastructure, cloud repatriation, infrastructure-as-a-platform.

Identify: dominant analyst narratives shaping buyer decisions, coverage gaps no vendor is filling, emerging frameworks or terms gaining traction, and narratives that challenge the status quo in digital infrastructure.

IMPORTANT: Only surface coverage and commentary from the past 14 days. Ignore anything older.
IMPORTANT: Keep each JSON field to 1-2 concise sentences maximum. Be specific but brief.
IMPORTANT: Report what analysts actually wrote — do NOT reframe through any vendor lens. Use the analysts own terminology, not Equinix product names or marketing language. Include critical or skeptical analyst perspectives.
IMPORTANT: For each narrative, include a "source" (publication name) and "url" (the actual URL). Only cite real, verifiable sources.

Return ONLY valid JSON (no markdown, no explanation):
{
  "dominant_narratives": [
    {"topic": "...", "narrative": "...", "implication": "...", "source": "...", "url": "..."},
    {"topic": "...", "narrative": "...", "implication": "...", "source": "...", "url": "..."},
    {"topic": "...", "narrative": "...", "implication": "...", "source": "...", "url": "..."}
  ],
  "coverage_gap": "The most important underserved topic in this space right now.",
  "rising_term": "One emerging term or framework gaining analyst traction."
}`;

const SYNTH_SYSTEM = `You are a strategic communications advisor helping Equinix identify narrative opportunities based on real market intelligence. Your job is to find gaps between what the market believes and what is actually true — not to validate existing Equinix messaging.

Using the intelligence provided, do TWO things:

PART 1 — COUNTERNARRATIVES
Synthesize 3 counternarrative opportunities. Each should:
- Challenge a real prevailing market assumption (not a straw man)
- Be grounded in actual buyer pain or analyst insight from the signals — cite which signal it came from
- Identify what Equinix would need to credibly prove (not just assert) to own this narrative
- Honestly note where Equinix is strong AND where it has gaps

PART 2 — RESEARCH BRIEF PROPOSAL
For the #1 priority counternarrative, generate a thought leadership research study proposal that Equinix could commission to build credibility and generate top-of-funnel content. This should be the kind of study that produces a flagship report, not a product brief.

The research brief must include:
- working_title: A compelling, non-branded report title (no Equinix name)
- subtitle: A clarifying subtitle
- central_question: The hypothesis the study will prove or disprove — frame as a question
- respondent_profile: An object with titles (array of job titles), company_size (e.g. "1,000+ employees"), verticals (array of 4-6 target industries), geography (target regions), sample_size (recommended N with brief rationale)
- methodology_options: Array of 3 options, each with name, description (1-2 sentences), and tradeoff (1 sentence on pros/cons)
- research_themes: Array of exactly 5 theme strings — the major sections of the final report
- output_formats: Array of deliverable formats (e.g. "Flagship PDF report", "Executive summary infographic", "Webinar series", etc.)
- activation_intent: 1-2 sentences on how Equinix would use this research for demand gen and thought leadership without it feeling like a product pitch

IMPORTANT: Keep each JSON field to 1-2 concise sentences maximum. Headlines should be punchy (under 10 words).
IMPORTANT: Do NOT use Equinix product names or branded terms (no "Platform Equinix", "Equinix Fabric", "IBX", etc.). Use plain industry language a buyer would use. Write as an outside advisor, not an internal marketer.
IMPORTANT: The research brief title and themes should be genuinely useful to the industry — something a CIO would download even if they never buy from Equinix.

Return ONLY valid JSON (no markdown, no explanation):
{
  "counternarratives": [
    {"headline": "...", "prevailing_assumption": "...", "reality": "...", "equinix_credibility": "...", "equinix_gap": "...", "activations": [{"idea":"...","format":"...","channel":"..."},{"idea":"...","format":"...","channel":"..."},{"idea":"...","format":"...","channel":"..."}]},
    {"headline": "...", "prevailing_assumption": "...", "reality": "...", "equinix_credibility": "...", "equinix_gap": "...", "activations": [{"idea":"...","format":"...","channel":"..."},{"idea":"...","format":"...","channel":"..."},{"idea":"...","format":"...","channel":"..."}]},
    {"headline": "...", "prevailing_assumption": "...", "reality": "...", "equinix_credibility": "...", "equinix_gap": "...", "activations": [{"idea":"...","format":"...","channel":"..."},{"idea":"...","format":"...","channel":"..."},{"idea":"...","format":"...","channel":"..."}]}
  ],
  "priority_narrative": "Which of the three to lead with and why, in 1-2 sentences.",
  "research_brief": {
    "working_title": "...", "subtitle": "...", "central_question": "...",
    "respondent_profile": {"titles": ["CIO", "CTO", "..."], "company_size": "...", "verticals": ["...","...","...","..."], "geography": "...", "sample_size": "..."},
    "methodology_options": [{"name":"...","description":"...","tradeoff":"..."},{"name":"...","description":"...","tradeoff":"..."},{"name":"...","description":"...","tradeoff":"..."}],
    "research_themes": ["...","...","...","...","..."],
    "output_formats": ["...","...","...","..."],
    "activation_intent": "..."
  }
}`;

const CONTENT_STRATEGY_SYSTEM = `You are a senior content strategist for Equinix marketing. You are given a set of counternarrative opportunities and a research brief synthesized from real market intelligence. Turn them into an actionable content strategy and a phased 90-day execution plan.

Your job:
- Derive 3-4 content pillars from the counternarratives. Each pillar is a durable theme the brand can own, tied back to a specific counternarrative.
- Build a 90-day plan in three 30-day phases. Each phase needs a theme, 2-3 objectives, specific key content pieces (with format), the channels to run on, and one primary KPI.
- Produce prioritized activation recommendations — concrete plays the team can execute, each with a channel and a priority.

IMPORTANT: Keep each JSON field to 1-2 concise sentences maximum. Be specific and executable, not generic.
IMPORTANT: Do NOT use Equinix product names or branded terms. Use plain industry language a buyer would use.
IMPORTANT: Ground pillars and plays in the actual counternarratives provided — reference them, do not invent new market claims.

Return ONLY valid JSON (no markdown, no explanation):
{
  "strategic_summary": "1-2 sentences on the overarching content strategy.",
  "content_pillars": [{"name": "...", "rationale": "...", "source_narrative": "Which counternarrative this maps to."}],
  "ninety_day_plan": [
    {"phase": "Days 1–30", "theme": "...", "objectives": ["...","..."], "key_content": [{"title":"...","format":"..."}], "channels": ["...","..."], "primary_kpi": "..."},
    {"phase": "Days 31–60", "theme": "...", "objectives": ["...","..."], "key_content": [{"title":"...","format":"..."}], "channels": ["...","..."], "primary_kpi": "..."},
    {"phase": "Days 61–90", "theme": "...", "objectives": ["...","..."], "key_content": [{"title":"...","format":"..."}], "channels": ["...","..."], "primary_kpi": "..."}
  ],
  "activation_recommendations": [{"play": "...", "description": "...", "channel": "...", "priority": "High"}]
}`;

const CAMPAIGN_SYSTEM = `You are a campaign architect and creative director for Equinix marketing. You are given a content strategy and 90-day plan. Turn it into an integrated campaign architecture and design system.

Your job:
- Define a campaign concept: a memorable name, a big idea, and a tagline.
- Map the audience architecture: the key segments, each segment's role in the funnel, and the core message for each.
- Lay out a full-funnel structure (Awareness, Consideration, Decision) — for each stage give an objective, the hero assets, the channels, and the primary CTA.
- Specify a creative system: visual direction, tone of voice, and a few recurring motifs.
- Provide a measurement framework: the metrics that matter, mapped to funnel stage, with a target each.

IMPORTANT: Keep each JSON field to 1-2 concise sentences maximum. The campaign must clearly trace back to the content pillars provided.
IMPORTANT: Do NOT use Equinix product names or branded terms. Use plain industry language.

Return ONLY valid JSON (no markdown, no explanation):
{
  "campaign_concept": {"name": "...", "big_idea": "...", "tagline": "..."},
  "audience_architecture": [{"segment": "...", "funnel_role": "...", "core_message": "..."}],
  "funnel_stages": [
    {"stage": "Awareness", "objective": "...", "assets": ["...","..."], "channels": ["...","..."], "cta": "..."},
    {"stage": "Consideration", "objective": "...", "assets": ["...","..."], "channels": ["...","..."], "cta": "..."},
    {"stage": "Decision", "objective": "...", "assets": ["...","..."], "channels": ["...","..."], "cta": "..."}
  ],
  "creative_system": {"visual_direction": "...", "tone": "...", "motifs": ["...","..."]},
  "measurement_framework": [{"metric": "...", "stage": "...", "target": "..."}]
}`;

const VERTICALS_SYSTEM = `You are a vertical marketing strategist for Equinix. You are given a content strategy and a campaign architecture. Produce industry-specific variations for exactly these four verticals:
1. Financial services
2. Telecom & digital media
3. High-tech (SaaS, clouds, neoclouds)
4. Public sector (government, education, municipalities)

For each vertical, adapt the core narrative and campaign to that industry's realities — regulatory environment, buying dynamics, and the specific infrastructure pain points that industry feels.

IMPORTANT: Keep each JSON field to 1-2 concise sentences maximum. Make each vertical genuinely distinct — do not just swap the industry name into the same sentence.
IMPORTANT: Do NOT use Equinix product names or branded terms. Use language a buyer in that industry would actually use.
IMPORTANT: Return exactly four verticals, in the order listed above.

Return ONLY valid JSON (no markdown, no explanation):
{
  "verticals": [
    {"vertical": "Financial services", "industry_angle": "...", "pain_points": ["...","..."], "tailored_message": "...", "proof_points": ["...","..."], "campaign_adaptation": "...", "priority_channels": ["...","..."], "sample_headline": "..."},
    {"vertical": "Telecom & digital media", "industry_angle": "...", "pain_points": ["...","..."], "tailored_message": "...", "proof_points": ["...","..."], "campaign_adaptation": "...", "priority_channels": ["...","..."], "sample_headline": "..."},
    {"vertical": "High-tech (SaaS, clouds, neoclouds)", "industry_angle": "...", "pain_points": ["...","..."], "tailored_message": "...", "proof_points": ["...","..."], "campaign_adaptation": "...", "priority_channels": ["...","..."], "sample_headline": "..."},
    {"vertical": "Public sector (government, education, municipalities)", "industry_angle": "...", "pain_points": ["...","..."], "tailored_message": "...", "proof_points": ["...","..."], "campaign_adaptation": "...", "priority_channels": ["...","..."], "sample_headline": "..."}
  ]
}`;

/* ════════════ EMAIL BUILDER ════════════ */

function esc(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const H2 = 'font-size:15px;color:#0f6e56;margin:20px 0 12px;border-bottom:1px solid #eee;padding-bottom:8px';
const LABEL = 'font-size:10px;text-transform:uppercase;color:#888;font-weight:500;letter-spacing:0.05em;margin-bottom:4px';

function buildBriefHtml({ customer, competitive, media, synth, content, campaign, verticals }) {
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' });
  let body = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;max-width:680px;margin:0 auto;color:#1a1a18">
  <div style="background:#0f6e56;color:white;padding:20px 24px;border-radius:8px 8px 0 0">
    <h1 style="margin:0;font-size:18px;font-weight:500">Intelligence Hub Brief</h1>
    <p style="margin:6px 0 0;font-size:13px;opacity:0.85">${dateStr}</p>
  </div>
  <div style="padding:24px;background:#ffffff;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 8px 8px">`;

  if (customer && customer.top_signals) {
    body += `<h2 style="${H2};margin-top:0">Customer Listening</h2>`;
    customer.top_signals.forEach(s => {
      const src = s.url ? `<a href="${s.url}" style="color:#0f6e56;font-size:11px">[${esc(s.source || 'source')}]</a>` : '';
      body += `<div style="margin-bottom:10px;font-size:13px;line-height:1.6"><strong>${esc(s.persona)}:</strong> ${esc(s.signal)} <span style="color:#888">→ ${esc(s.implication)}</span> ${src}</div>`;
    });
    if (customer.emerging_theme) body += `<div style="background:#e6f1fb;padding:10px 14px;border-radius:6px;font-size:12px;color:#0c447c;margin:8px 0 20px"><strong>Theme:</strong> ${esc(customer.emerging_theme)}</div>`;
  }

  if (competitive && competitive.tiers) {
    body += `<h2 style="${H2}">Competitive Listening</h2>`;
    competitive.tiers.forEach(t => {
      const src = t.url ? `<a href="${t.url}" style="color:#0f6e56;font-size:11px">[${esc(t.source || 'source')}]</a>` : '';
      body += `<div style="margin-bottom:14px"><div style="${LABEL}">${esc(t.tier)}</div>`;
      body += `<div style="font-size:13px;line-height:1.6"><strong>Move:</strong> ${esc(t.key_move)}</div>`;
      body += `<div style="font-size:13px;line-height:1.6"><strong>Risk:</strong> ${esc(t.market_risk || '')}</div>`;
      body += `<div style="font-size:13px;line-height:1.6"><strong>Gap:</strong> ${esc(t.gap_exposed || '')} ${src}</div></div>`;
    });
    if (competitive.headline_vulnerability) body += `<div style="background:#fcebeb;padding:10px 14px;border-radius:6px;font-size:12px;color:#a32d2d;margin:8px 0 20px"><strong>Headline vulnerability:</strong> ${esc(competitive.headline_vulnerability)}</div>`;
  }

  if (media && media.dominant_narratives) {
    body += `<h2 style="${H2}">Media & Analyst Listening</h2>`;
    media.dominant_narratives.forEach(d => {
      const src = d.url ? `<a href="${d.url}" style="color:#0f6e56;font-size:11px">[${esc(d.source || 'source')}]</a>` : '';
      body += `<div style="margin-bottom:10px;font-size:13px;line-height:1.6"><strong>${esc(d.topic)}:</strong> ${esc(d.narrative)} <span style="color:#888">→ ${esc(d.implication || '')}</span> ${src}</div>`;
    });
    if (media.coverage_gap) body += `<div style="font-size:13px;margin-top:8px"><strong>Coverage gap:</strong> ${esc(media.coverage_gap)}</div>`;
    if (media.rising_term) body += `<div style="font-size:13px;margin-top:4px;margin-bottom:16px"><strong>Rising term:</strong> ${esc(media.rising_term)}</div>`;
  }

  if (synth && synth.counternarratives) {
    body += `<h2 style="${H2}">Counternarratives</h2>`;
    synth.counternarratives.forEach((cn, i) => {
      body += `<div style="border-left:2px solid #ccc;padding-left:14px;margin-bottom:16px">`;
      body += `<div style="font-size:14px;font-weight:600;margin-bottom:5px">${i + 1}. ${esc(cn.headline)}</div>`;
      body += `<div style="font-size:12px;color:#555;line-height:1.6"><strong>Assumption:</strong> ${esc(cn.prevailing_assumption || '')}</div>`;
      body += `<div style="font-size:12px;color:#555;line-height:1.6"><strong>Reality:</strong> ${esc(cn.reality || '')}</div>`;
      body += `<div style="font-size:12px;color:#555;line-height:1.6"><strong>Credibility:</strong> ${esc(cn.equinix_credibility || '')}</div>`;
      if (cn.equinix_gap) body += `<div style="font-size:12px;color:#a32d2d;line-height:1.6"><strong>Gap:</strong> ${esc(cn.equinix_gap)}</div>`;
      body += `</div>`;
    });
    if (synth.priority_narrative) body += `<div style="background:#e1f5ee;padding:10px 14px;border-radius:6px;font-size:12px;color:#085041;margin:8px 0 16px"><strong>Lead with:</strong> ${esc(synth.priority_narrative)}</div>`;
  }

  if (synth && synth.research_brief) {
    const rb = synth.research_brief;
    body += `<div style="margin-top:16px;border:1px solid #0f6e56;border-radius:8px;overflow:hidden">`;
    body += `<div style="background:#e1f5ee;padding:12px 16px;border-bottom:1px solid #0f6e56"><h2 style="margin:0;font-size:14px;color:#085041">Research Brief Proposal</h2></div>`;
    body += `<div style="padding:16px">`;
    body += `<div style="font-size:16px;font-weight:600;margin-bottom:2px">${esc(rb.working_title || '')}</div>`;
    body += `<div style="font-size:13px;color:#666;margin-bottom:14px">${esc(rb.subtitle || '')}</div>`;
    body += `<div style="margin-bottom:14px"><div style="${LABEL}">Central Research Question</div><div style="font-size:13px;font-style:italic">${esc(rb.central_question || '')}</div></div>`;
    if (rb.respondent_profile) {
      const rp = rb.respondent_profile;
      body += `<div style="margin-bottom:14px"><div style="${LABEL}">Target Respondent Profile</div>`;
      if (rp.titles) body += `<div style="font-size:13px;margin-bottom:3px"><strong>Titles:</strong> ${esc((rp.titles || []).join(', '))}</div>`;
      if (rp.company_size) body += `<div style="font-size:13px;margin-bottom:3px"><strong>Company size:</strong> ${esc(rp.company_size)}</div>`;
      if (rp.verticals) body += `<div style="font-size:13px;margin-bottom:3px"><strong>Verticals:</strong> ${esc((rp.verticals || []).join(', '))}</div>`;
      if (rp.geography) body += `<div style="font-size:13px;margin-bottom:3px"><strong>Geography:</strong> ${esc(rp.geography)}</div>`;
      if (rp.sample_size) body += `<div style="font-size:13px"><strong>Sample size:</strong> ${esc(rp.sample_size)}</div>`;
      body += `</div>`;
    }
    if (rb.methodology_options) {
      body += `<div style="margin-bottom:14px"><div style="${LABEL}">Methodology Options</div>`;
      rb.methodology_options.forEach(m => {
        body += `<div style="background:#f7f7f5;border-radius:6px;padding:10px 12px;margin-bottom:6px"><div style="font-size:13px;font-weight:500;margin-bottom:2px">${esc(m.name || '')}</div><div style="font-size:12px;color:#666">${esc(m.description || '')}</div><div style="font-size:11px;color:#888;font-style:italic;margin-top:2px">Tradeoff: ${esc(m.tradeoff || '')}</div></div>`;
      });
      body += `</div>`;
    }
    if (rb.research_themes) {
      body += `<div style="margin-bottom:14px"><div style="${LABEL}">Key Research Themes</div>`;
      rb.research_themes.forEach(t => { body += `<div style="font-size:13px;padding:3px 0;border-bottom:1px solid #eee">◆ ${esc(t)}</div>`; });
      body += `</div>`;
    }
    if (rb.output_formats) {
      body += `<div style="margin-bottom:14px"><div style="${LABEL}">Output Formats</div><div>`;
      rb.output_formats.forEach(f => { body += `<span style="display:inline-block;font-size:11px;padding:3px 9px;border-radius:20px;background:#e1f5ee;color:#085041;margin:0 4px 4px 0">${esc(f)}</span>`; });
      body += `</div></div>`;
    }
    if (rb.activation_intent) body += `<div><div style="${LABEL}">Activation Intent</div><div style="font-size:13px">${esc(rb.activation_intent)}</div></div>`;
    body += `</div></div>`;
  }

  if (content && content.content_pillars) {
    body += `<h2 style="${H2}">Content Strategy &amp; 90-Day Plan</h2>`;
    if (content.strategic_summary) body += `<div style="font-size:13px;margin-bottom:10px"><strong>Strategy:</strong> ${esc(content.strategic_summary)}</div>`;
    body += `<div style="${LABEL}">Content Pillars</div>`;
    content.content_pillars.forEach(p => {
      body += `<div style="margin-bottom:8px;font-size:13px;line-height:1.6"><strong>${esc(p.name)}</strong> — ${esc(p.rationale || '')}${p.source_narrative ? ` <span style="color:#888">(from: ${esc(p.source_narrative)})</span>` : ''}</div>`;
    });
    if (content.ninety_day_plan) {
      body += `<div style="${LABEL};margin-top:12px">90-Day Plan</div>`;
      content.ninety_day_plan.forEach(ph => {
        body += `<div style="border-left:2px solid #ccc;padding-left:12px;margin-bottom:10px">`;
        body += `<div style="font-size:13px;font-weight:600">${esc(ph.phase)} — ${esc(ph.theme || '')}</div>`;
        if (ph.objectives) body += `<div style="font-size:12px;color:#555"><strong>Objectives:</strong> ${esc((ph.objectives || []).join('; '))}</div>`;
        if (ph.key_content) body += `<div style="font-size:12px;color:#555"><strong>Content:</strong> ${esc((ph.key_content || []).map(c => `${c.title} (${c.format})`).join('; '))}</div>`;
        if (ph.channels) body += `<div style="font-size:12px;color:#888"><strong>Channels:</strong> ${esc((ph.channels || []).join(', '))}</div>`;
        if (ph.primary_kpi) body += `<div style="font-size:12px;color:#085041"><strong>KPI:</strong> ${esc(ph.primary_kpi)}</div>`;
        body += `</div>`;
      });
    }
    if (content.activation_recommendations) {
      body += `<div style="${LABEL};margin-top:12px">Activation Recommendations</div>`;
      content.activation_recommendations.forEach(a => {
        body += `<div style="font-size:13px;margin-bottom:6px"><strong>${esc(a.play)}</strong> — ${esc(a.description || '')} <span style="color:#888">[${esc(a.channel || '')} · ${esc(a.priority || '')}]</span></div>`;
      });
    }
  }

  if (campaign && campaign.campaign_concept) {
    const c = campaign.campaign_concept;
    body += `<h2 style="${H2}">Campaign Architecture</h2>`;
    body += `<div style="font-size:15px;font-weight:600">${esc(c.name || '')}</div>`;
    body += `<div style="font-size:13px;font-style:italic;color:#555;margin-bottom:4px">${esc(c.tagline || '')}</div>`;
    body += `<div style="font-size:13px;color:#555;margin-bottom:12px">${esc(c.big_idea || '')}</div>`;
    if (campaign.audience_architecture) {
      body += `<div style="${LABEL}">Audience Architecture</div>`;
      campaign.audience_architecture.forEach(a => { body += `<div style="font-size:13px;margin-bottom:5px"><strong>${esc(a.segment)}</strong> <span style="color:#888">(${esc(a.funnel_role || '')})</span> — ${esc(a.core_message || '')}</div>`; });
    }
    if (campaign.funnel_stages) {
      body += `<div style="${LABEL};margin-top:12px">Funnel Structure</div>`;
      campaign.funnel_stages.forEach(s => {
        body += `<div style="border-left:2px solid #ccc;padding-left:12px;margin-bottom:10px"><div style="font-size:13px;font-weight:600">${esc(s.stage)}</div>`;
        body += `<div style="font-size:12px;color:#555">${esc(s.objective || '')}</div>`;
        if (s.assets) body += `<div style="font-size:12px;color:#555"><strong>Assets:</strong> ${esc((s.assets || []).join(', '))}</div>`;
        if (s.channels) body += `<div style="font-size:12px;color:#888"><strong>Channels:</strong> ${esc((s.channels || []).join(', '))}</div>`;
        if (s.cta) body += `<div style="font-size:12px;color:#085041"><strong>CTA:</strong> ${esc(s.cta)}</div>`;
        body += `</div>`;
      });
    }
    if (campaign.creative_system) {
      const cs = campaign.creative_system;
      body += `<div style="${LABEL};margin-top:12px">Creative System</div>`;
      body += `<div style="font-size:13px"><strong>Visual:</strong> ${esc(cs.visual_direction || '')}</div>`;
      body += `<div style="font-size:13px"><strong>Tone:</strong> ${esc(cs.tone || '')}</div>`;
      if (cs.motifs) body += `<div style="font-size:13px"><strong>Motifs:</strong> ${esc((cs.motifs || []).join(', '))}</div>`;
    }
    if (campaign.measurement_framework) {
      body += `<div style="${LABEL};margin-top:12px">Measurement</div>`;
      campaign.measurement_framework.forEach(m => { body += `<div style="font-size:13px;margin-bottom:4px"><strong>${esc(m.metric)}</strong> <span style="color:#888">(${esc(m.stage || '')})</span> → ${esc(m.target || '')}</div>`; });
    }
  }

  if (verticals && verticals.verticals) {
    body += `<h2 style="${H2}">Vertical Variations</h2>`;
    verticals.verticals.forEach(v => {
      body += `<div style="border-left:2px solid #ccc;padding-left:14px;margin-bottom:16px">`;
      body += `<div style="font-size:14px;font-weight:600;margin-bottom:5px">${esc(v.vertical)}</div>`;
      if (v.sample_headline) body += `<div style="background:#e6f1fb;padding:8px 12px;border-radius:6px;font-size:12px;color:#0c447c;margin-bottom:8px">“${esc(v.sample_headline)}”</div>`;
      body += `<div style="font-size:12px;color:#555;line-height:1.6"><strong>Angle:</strong> ${esc(v.industry_angle || '')}</div>`;
      if (v.pain_points) body += `<div style="font-size:12px;color:#555;line-height:1.6"><strong>Pain points:</strong> ${esc((v.pain_points || []).join('; '))}</div>`;
      body += `<div style="font-size:12px;color:#555;line-height:1.6"><strong>Message:</strong> ${esc(v.tailored_message || '')}</div>`;
      if (v.proof_points) body += `<div style="font-size:12px;color:#888;line-height:1.6"><strong>Proof:</strong> ${esc((v.proof_points || []).join('; '))}</div>`;
      body += `<div style="font-size:12px;color:#555;line-height:1.6"><strong>Campaign shift:</strong> ${esc(v.campaign_adaptation || '')}</div>`;
      if (v.priority_channels) body += `<div style="font-size:12px;color:#888;line-height:1.6"><strong>Channels:</strong> ${esc((v.priority_channels || []).join(', '))}</div>`;
      body += `</div>`;
    });
  }

  body += `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #eee;font-size:11px;color:#888">Generated automatically by Intelligence Hub · <a href="https://intelligence-hub-psi.vercel.app" style="color:#0f6e56">Open in browser</a></div>
  </div>
</div>`;
  return body;
}

async function sendEmail(html) {
  const resendKey = process.env.RESEND_API_KEY;
  const recipients = (process.env.BRIEF_RECIPIENT_EMAIL || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!resendKey) throw new Error('RESEND_API_KEY not configured');
  if (recipients.length === 0) throw new Error('BRIEF_RECIPIENT_EMAIL not configured');

  const subject = 'Intelligence Hub Brief — ' + new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });
  const resp = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}` },
    body: JSON.stringify({
      from: process.env.BRIEF_FROM_EMAIL || 'Intelligence Hub <onboarding@resend.dev>',
      to: recipients,
      subject,
      html,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Resend error ${resp.status}: ${data.message || JSON.stringify(data)}`);
  return data.id;
}

/* ════════════ MAIN ════════════ */

async function main() {
  const force = process.env.FORCE_RUN === 'true';
  const { weekday, hour } = pacificNow();
  console.log(`Pacific time check: ${weekday} ${hour}:xx — force=${force}`);
  if (!force && !(weekday === 'Mon' && hour === 8)) {
    console.log('Not 8am Monday Pacific — skipping (this is expected for the off-DST trigger).');
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');

  const webTools = [{ type: 'web_search_20250305', name: 'web_search' }];
  const today = new Date().toISOString().split('T')[0];
  const sweepUser = `Run the sweep now. Today’s date is ${today}.`;

  console.log('Running 3 listening sweeps in parallel…');
  const [customerRaw, competitiveRaw, mediaRaw] = await Promise.all([
    callModel({ system: CUSTOMER_SYSTEM, tools: webTools, maxTokens: 4096, userText: sweepUser }),
    callModel({ system: COMPETITIVE_SYSTEM, tools: webTools, maxTokens: 4096, userText: sweepUser }),
    callModel({ system: MEDIA_SYSTEM, tools: webTools, maxTokens: 4096, userText: sweepUser }),
  ]);
  const customer = parseJson(customerRaw);
  const competitive = parseJson(competitiveRaw);
  const media = parseJson(mediaRaw);
  console.log(`Sweeps done — customer:${!!customer} competitive:${!!competitive} media:${!!media}`);

  if (!customer && !competitive && !media) throw new Error('All three sweeps failed to parse — aborting.');

  console.log('Synthesizing counternarratives…');
  const synthCtx = `Using the intelligence below, synthesize counternarrative opportunities.\n\nCUSTOMER SIGNALS: ${JSON.stringify(customer || 'not run')}\nCOMPETITIVE SIGNALS: ${JSON.stringify(competitive || 'not run')}\nMEDIA & ANALYST SIGNALS: ${JSON.stringify(media || 'not run')}`;
  const synth = parseJson(await callModel({ system: SYNTH_SYSTEM, maxTokens: 8192, userText: synthCtx }));
  console.log(`Synthesis done — ${!!synth}`);

  let content = null, campaign = null, verticals = null;
  if (synth && synth.counternarratives) {
    console.log('Building content strategy…');
    content = parseJson(await callModel({ system: CONTENT_STRATEGY_SYSTEM, maxTokens: 8192, userText: `Build a content strategy and 90-day plan from this counternarrative synthesis:\n\n${JSON.stringify(synth)}` }));

    if (content) {
      console.log('Designing campaign…');
      campaign = parseJson(await callModel({ system: CAMPAIGN_SYSTEM, maxTokens: 8192, userText: `Design a campaign architecture from this content strategy and 90-day plan:\n\n${JSON.stringify(content)}` }));
    }
    if (content && campaign) {
      console.log('Adapting to verticals…');
      verticals = parseJson(await callModel({ system: VERTICALS_SYSTEM, maxTokens: 8192, userText: `Create industry-specific variations for financial services, telecom & digital media, high-tech, and public sector.\n\nCONTENT STRATEGY: ${JSON.stringify(content)}\n\nCAMPAIGN ARCHITECTURE: ${JSON.stringify(campaign)}` }));
    }
  } else {
    console.log('Synthesis produced no counternarratives — sending listening brief without downstream agents.');
  }

  console.log('Building and sending email…');
  const html = buildBriefHtml({ customer, competitive, media, synth, content, campaign, verticals });
  const id = await sendEmail(html);
  console.log(`Email sent via Resend — id: ${id}`);
}

// Run unless imported for testing (WEEKLY_BRIEF_RUN=0).
if (process.env.WEEKLY_BRIEF_RUN !== '0') {
  main().catch(err => {
    console.error('Weekly brief failed:', err.message);
    process.exit(1);
  });
}

export { buildBriefHtml, pacificNow, parseJson, esc };

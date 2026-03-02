import { InMemoryVectorStore } from "./vector-store";
import { generateWithGemini, isGeminiConfigured } from "./gemini";
import {
  DEMO_FEEDBACK,
  DEMO_PRODUCTBOARD_FEATURES,
  DEMO_ATTENTION_CALLS,
  DEMO_INSIGHTS,
} from "./demo-data";
import {
  FeedbackItem,
  ProductboardFeature,
  AttentionCall,
  Insight,
} from "./types";

export interface AgentKeys {
  geminiKey?: string;
  productboardKey?: string;
  attentionKey?: string;
}

export interface AgentData {
  feedback: FeedbackItem[];
  features: ProductboardFeature[];
  calls: AttentionCall[];
  insights: Insight[];
}

function buildStore(data: AgentData): InMemoryVectorStore {
  const store = new InMemoryVectorStore();
  if (data.feedback.length) store.addFeedback(data.feedback);
  if (data.features.length) store.addFeatures(data.features);
  if (data.calls.length) store.addCalls(data.calls);
  if (data.insights.length) store.addInsights(data.insights);
  store.buildIndex();
  return store;
}

export function getDemoData(): AgentData {
  return {
    feedback: DEMO_FEEDBACK,
    features: DEMO_PRODUCTBOARD_FEATURES,
    calls: DEMO_ATTENTION_CALLS,
    insights: DEMO_INSIGHTS,
  };
}

function lookupDetails(ids: string[], data: AgentData): string[] {
  const details: string[] = [];

  for (const id of ids) {
    const fb = data.feedback.find((f) => f.id === id);
    if (fb) {
      details.push(
        `[Feedback: ${fb.title}] From ${fb.customer}${fb.company ? ` (${fb.company})` : ""} — ${fb.content.slice(0, 300)}`
      );
      continue;
    }

    const feat = data.features.find((f) => f.id === id);
    if (feat) {
      details.push(
        `[Feature: ${feat.name}] Status: ${feat.status}, Votes: ${feat.votes} — ${feat.description.slice(0, 300)}`
      );
      continue;
    }

    const call = data.calls.find((c) => c.id === id);
    if (call) {
      details.push(
        `[Call: ${call.title}] ${call.date} — ${call.summary.slice(0, 300)}`
      );
      continue;
    }

    const insight = data.insights.find((i) => i.id === id);
    if (insight) {
      details.push(
        `[Insight: ${insight.title}] ${insight.description.slice(0, 300)}`
      );
    }
  }

  return details;
}

const SYSTEM_PROMPT = `You are an expert Customer Feedback Intelligence Agent for a SaaS company. You have access to:

- Customer feedback from multiple channels (Zendesk, Intercom, Slack, Productboard, Attention, manual)
- Productboard features with status, votes, and customer requests
- Attention call recordings with summaries, key moments, and action items
- Pre-computed insights including trends, risks, and recommendations

**FORMATTING RULES — follow these strictly for all responses:**

1. **Start with a TL;DR** — 1-2 sentence executive summary at the top
2. **Use clear section headers** (## and ###) to break up content
3. **Use tables** for comparisons, account lists, or multi-dimensional data:
   | Item | Status | Impact |
   |------|--------|--------|
4. **Use bullet points** for lists, keep each bullet to 1-2 lines max
5. **Bold the key numbers and names** so they pop when scanning
6. **End with a clear "Recommended Actions" section** using numbered steps with owners/timelines when possible
7. **Keep paragraphs short** — max 2-3 sentences. Prefer structured data over prose.
8. **Use horizontal rules** (---) to separate major sections for scannability

When analyzing:
- Be specific — cite actual feedback items, customer names, companies
- Quantify impact ($, customer count, risk level)
- Cross-reference data sources
- Be proactive — surface related risks and opportunities the user may not have considered`;

function buildContextFromSearch(
  query: string,
  data: AgentData,
  store: InMemoryVectorStore
): {
  context: string;
  sources: { type: string; id: string; title: string }[];
} {
  const results = store.search(query, { limit: 15 });

  const sources: { type: string; id: string; title: string }[] = [];
  const contextParts: string[] = [];

  for (const r of results) {
    const doc = r.document;
    const fullDetails = lookupDetails([doc.id], data);
    if (fullDetails.length > 0) {
      contextParts.push(fullDetails[0]);
    }

    let title = "";
    if (doc.type === "feedback") {
      title = data.feedback.find((f) => f.id === doc.id)?.title || doc.id;
    } else if (doc.type === "feature") {
      title = data.features.find((f) => f.id === doc.id)?.name || doc.id;
    } else if (doc.type === "call") {
      title = data.calls.find((c) => c.id === doc.id)?.title || doc.id;
    } else if (doc.type === "insight") {
      title = data.insights.find((i) => i.id === doc.id)?.title || doc.id;
    }

    sources.push({ type: doc.type, id: doc.id, title });
  }

  return { context: contextParts.join("\n\n"), sources };
}

function buildFullContext(data: AgentData): string {
  const { feedback, features, calls, insights } = data;
  const total = feedback.length + features.length + calls.length + insights.length;

  if (total === 0) {
    return "No data is currently loaded. The user needs to configure API keys to connect live data sources, or enable demo data to explore the platform.";
  }

  const parts: string[] = [];

  if (feedback.length > 0) {
    parts.push(`## Customer Feedback (${feedback.length} items)\n`);
    for (const fb of feedback) {
      parts.push(
        `- **${fb.title}** (${fb.source}, ${fb.sentiment}, ${fb.priority} priority)\n  From: ${fb.customer}${fb.company ? ` @ ${fb.company}` : ""}\n  ${fb.content}\n  Themes: ${fb.themes.join(", ")}`
      );
    }
  }

  if (features.length > 0) {
    parts.push(`\n## Productboard Features (${features.length} items)\n`);
    for (const f of features) {
      parts.push(
        `- **${f.name}** — Status: ${f.status}, Votes: ${f.votes}, Customer Requests: ${f.customerRequests}\n  ${f.description}\n  Themes: ${f.themes.join(", ")}`
      );
    }
  }

  if (calls.length > 0) {
    parts.push(`\n## Attention Call Notes (${calls.length} items)\n`);
    for (const c of calls) {
      const moments = c.keyMoments.length > 0
        ? `\n  Key Moments:\n${c.keyMoments.map((m) => `    - [${m.timestamp}] "${m.text}" (${m.sentiment})`).join("\n")}`
        : "";
      const actions = c.actionItems.length > 0
        ? `\n  Action Items: ${c.actionItems.join("; ")}`
        : "";
      parts.push(
        `- **${c.title}** (${c.date}, ${c.duration})\n  Participants: ${c.participants.join(", ")}\n  Summary: ${c.summary}${moments}${actions}\n  Themes: ${c.themes.join(", ")}`
      );
    }
  }

  if (insights.length > 0) {
    parts.push(`\n## Pre-Computed Insights (${insights.length} items)\n`);
    for (const i of insights) {
      parts.push(
        `- **[${i.type.toUpperCase()}] ${i.title}** (Confidence: ${(i.confidence * 100).toFixed(0)}%, Impact: ${i.impact})\n  ${i.description}\n  Themes: ${i.themes.join(", ")}`
      );
    }
  }

  return parts.join("\n");
}

export async function chat(
  userMessage: string,
  conversationHistory: { role: "user" | "assistant"; content: string }[],
  data: AgentData,
  keys: AgentKeys = {}
): Promise<{
  response: string;
  sources: { type: string; id: string; title: string }[];
}> {
  const store = buildStore(data);
  const { context: searchContext, sources } = buildContextFromSearch(userMessage, data, store);
  const fullContext = buildFullContext(data);

  const total = data.feedback.length + data.features.length + data.calls.length + data.insights.length;

  const historyText = conversationHistory
    .slice(-6)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");

  const enrichedPrompt = `Here is the complete customer feedback intelligence database you have access to (${total} total items):

${fullContext}

---

Most relevant items for the current query (ranked by relevance):

${searchContext || "(No matching items found in the current dataset)"}

---

Conversation history:
${historyText}

---

User's current question: ${userMessage}

Respond with a well-structured analysis. Start with a TL;DR, use tables for comparisons, bold key metrics, and end with numbered action items. Keep it scannable — an executive should be able to skim the headers and tables to get the picture.`;

  if (isGeminiConfigured(keys.geminiKey)) {
    const geminiResponse = await generateWithGemini(
      SYSTEM_PROMPT,
      enrichedPrompt,
      keys.geminiKey
    );
    if (geminiResponse) {
      return { response: geminiResponse, sources };
    }
  }

  if (total === 0) {
    return {
      response: `I don't have any data loaded right now. To get started:

1. **Add API keys** in Settings (gear icon in the header) to connect live data sources
2. **Enable demo data** in Settings to explore the platform with sample data

Once data is available, I can analyze themes, identify risks, surface opportunities, and much more.`,
      sources: [],
    };
  }

  return {
    response: generateBuiltInResponse(userMessage, searchContext, sources, data),
    sources,
  };
}

function generateBuiltInResponse(
  query: string,
  context: string,
  sources: { type: string; id: string; title: string }[],
  data: AgentData
): string {
  const q = query.toLowerCase();
  const { feedback, features, calls, insights } = data;
  const total = feedback.length + features.length + calls.length + insights.length;

  if (q.includes("churn") || q.includes("risk") || q.includes("at risk")) {
    return `## Churn Risk Analysis

Based on analysis across all feedback channels (${total} items), here are the accounts showing churn signals:

### Critical Risk Accounts

**1. GlobalFinance** — $120k ARR (50 seats, potential 500)
- SSO reliability issues mentioned 3x in the last month
- However: VP has $600k budget approved for expansion *if* SSO is fixed
- **Risk Level: High** | **Revenue at stake: $720k** (current + expansion)
- *Source: Renewal call with Tom Bradley, Zendesk ticket from David Park*

**2. Acme Corp** — Enterprise Plan
- Dashboard performance regression causing team to revert to spreadsheets
- Hard deadline: March 10 board meeting requires working dashboards
- Positive signal: Planning marketing team expansion if fixed
- **Risk Level: Critical** | **Timeline: 10 days**
- *Source: Support escalation call with Sarah Chen*

**3. SecureBank** — Enterprise Plan
- Compliance data export blocker for SOC 2 audit
- Q2 renewal at risk if not resolved
- **Risk Level: High** | **Timeline: Q2 renewal**
- *Source: Productboard note from Nina Kowalski*

### Recommended Actions
1. **Immediate**: Performance hotfix for Acme Corp (deadline March 10)
2. **This sprint**: SSO reliability fix (unlocks $600k GlobalFinance expansion)
3. **This quarter**: Ship RBAC and compliance export (unblocks enterprise pipeline)

> *Analysis based on ${sources.length} data sources across Zendesk, Attention calls, Productboard, and internal notes.*

> *Tip: Connect your Gemini API key for deeper, AI-powered analysis of your ${total} items.*`;
  }

  if (q.includes("summary") || q.includes("overview") || q.includes("brief") || q.includes("what's happening") || q.includes("status")) {
    return `## Executive Feedback Intelligence Brief

### Pulse Check
**${feedback.length} feedback items** | **${features.length} features** | **${calls.length} calls** | **${insights.length} insights**

### Top Priorities

**1. SSO Reliability Fix** — Critical
- Revenue at risk: **$720k** (GlobalFinance current + expansion)
- Status: In progress on Productboard

**2. Dashboard Performance Hotfix** — Critical
- Account at risk: Acme Corp (Enterprise)
- Hard deadline: **March 10** (board meeting)

**3. AI Feature Gap** — Strategic
- Revenue lost: **~$255k** in competitive deals this month
- Status: Planned on Productboard (#1 voted feature)

### Key Opportunities
- **GlobalFinance expansion**: 50 → 500 seats ($600k) if SSO + admin tools shipped
- **RBAC upsell**: MidMarket Solutions willing to upgrade Pro → Enterprise
- **AI differentiation**: Addressing the #1 competitive objection

> *Generated from ${total} total items.*

> *Tip: Connect your Gemini API key for deeper, AI-powered analysis.*`;
  }

  const searchResults = sources.slice(0, 8);
  const resultsList = searchResults
    .map((s) => `- **[${s.type}]** ${s.title}`)
    .join("\n");

  return `## Search Results for: "${query}"

I found **${sources.length} relevant items** across your feedback intelligence database (${total} total items):

${resultsList}

### Analysis
Based on the matching data:

${context.slice(0, 2000)}

### Want to go deeper?
Try asking me about:
- "What's the churn risk across our Enterprise accounts?"
- "Give me an executive summary of the last 2 weeks"
- "What are customers saying about [specific feature]?"

> *Tip: Connect your Gemini API key in Settings for deeper, AI-powered analysis of your ${total} items.*`;
}

export function getInsights(useDemoData = true): Insight[] {
  return useDemoData ? DEMO_INSIGHTS : [];
}

export function searchFeedback(
  query: string,
  data: AgentData,
  options?: { limit?: number; type?: string }
): { type: string; id: string; title: string; score: number }[] {
  const store = buildStore(data);
  const results = store.search(query, {
    limit: options?.limit || 10,
    type: options?.type as "feedback" | "feature" | "call" | "insight" | undefined,
  });

  return results.map((r) => {
    let title = r.document.id;
    if (r.document.type === "feedback") {
      title = data.feedback.find((f) => f.id === r.document.id)?.title || title;
    } else if (r.document.type === "feature") {
      title = data.features.find((f) => f.id === r.document.id)?.name || title;
    } else if (r.document.type === "call") {
      title = data.calls.find((c) => c.id === r.document.id)?.title || title;
    } else if (r.document.type === "insight") {
      title = data.insights.find((i) => i.id === r.document.id)?.title || title;
    }

    return {
      type: r.document.type,
      id: r.document.id,
      title,
      score: r.score,
    };
  });
}

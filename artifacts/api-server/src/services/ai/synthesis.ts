import OpenAI from "openai";

const baseURL = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
const apiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!_client) {
    if (!baseURL || !apiKey) throw new Error("OpenAI integration env vars missing");
    _client = new OpenAI({ baseURL, apiKey });
  }
  return _client;
}

export interface AiInput {
  symbol: string;
  interval: string;
  currentPrice: number;
  regime: { hurst: number; regimeLabel: string; garchRegime: string };
  zones: Array<{
    priceLow: number;
    priceHigh: number;
    score: number;
    kind: string;
    methods: string[];
    preciseEntryPrice: number;
    entryMethod: string;
    bounceRate: number | null;
    pValue: number | null;
    confirmed: boolean;
  }>;
  signals: Array<{ name: string; value: number; label: string }>;
  crossPair?: Array<{ pair: string; zScore: number; signal: string }>;
}

export interface AiOutput {
  summary: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  recommendedEntry: number | null;
  direction: "long" | "short" | "neutral";
  reasoning: string[];
  consistency: string;
}

const SYSTEM_PROMPT = `You are a quantitative trading analyst summarising a single statistical analysis run on a Hyperliquid perpetual contract. You receive: the regime (Hurst exponent + GARCH volatility regime), a list of confluence zones (each with a precise entry price, source methods, validated bounce rate, p-value, and confirmation flag), a set of live order-flow signals, and cross-pair correlation z-scores.

Produce ONE plain-English assessment for the trader. Be terse, confident, never hedged with disclaimers. Do not mention stops, risk management, or position sizing — that is not your job. Do not invent classic chart patterns. Speak only about what the statistics say.

Output strict JSON with these fields:
- summary: one short sentence (under 25 words)
- confidence: "HIGH" | "MEDIUM" | "LOW"
- recommendedEntry: number (the precise entry price of the highest-scoring confirmed zone aligned with the dominant direction) or null if nothing actionable
- direction: "long" | "short" | "neutral"
- reasoning: 2-4 short bullets, each under 14 words, citing actual signals/zones
- consistency: one short phrase rating how well the signals agree (e.g. "tight agreement", "split signals", "mixed flow")

Only output the JSON object — no prose, no markdown.`;

// Short-TTL in-memory cache so repeated requests within ~30s reuse the same
// expensive AI synthesis. Keyed on a stable hash of the meaningful inputs.
const TTL_MS = 30_000;
const cache = new Map<string, { value: AiOutput; expiresAt: number }>();

function cacheKey(input: AiInput): string {
  const zonesKey = input.zones
    .map((z) => `${z.kind}:${z.preciseEntryPrice.toFixed(2)}:${z.score.toFixed(1)}:${z.confirmed ? 1 : 0}`)
    .join("|");
  const sigKey = input.signals
    .map((s) => `${s.name}:${typeof s.value === "number" ? s.value.toFixed(3) : s.value}`)
    .join("|");
  return `${input.symbol}|${input.interval}|${input.regime.regimeLabel}|${input.regime.garchRegime}|${zonesKey}|${sigKey}`;
}

export async function synthesize(input: AiInput): Promise<AiOutput> {
  const key = cacheKey(input);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;

  let value: AiOutput;
  try {
    const userPrompt = JSON.stringify(input);
    const resp = await client().chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 600,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    });
    const text = resp.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(text);
    value = normalize(parsed, input);
  } catch {
    value = fallback(input);
  }

  cache.set(key, { value, expiresAt: now + TTL_MS });
  // Trim if cache grows too large.
  if (cache.size > 200) {
    const keys = [...cache.keys()].slice(0, cache.size - 200);
    for (const k of keys) cache.delete(k);
  }
  return value;
}

function normalize(p: unknown, input: AiInput): AiOutput {
  const obj = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
  const dir = (obj["direction"] as string) ?? "neutral";
  const conf = (obj["confidence"] as string) ?? "LOW";
  return {
    summary: (obj["summary"] as string) ?? fallback(input).summary,
    confidence: (["HIGH", "MEDIUM", "LOW"].includes(conf) ? conf : "LOW") as AiOutput["confidence"],
    recommendedEntry: typeof obj["recommendedEntry"] === "number" ? (obj["recommendedEntry"] as number) : null,
    direction: (["long", "short", "neutral"].includes(dir) ? dir : "neutral") as AiOutput["direction"],
    reasoning: Array.isArray(obj["reasoning"]) ? (obj["reasoning"] as string[]).slice(0, 4) : [],
    consistency: (obj["consistency"] as string) ?? "insufficient signal",
  };
}

function fallback(input: AiInput): AiOutput {
  const top = [...input.zones].sort((a, b) => b.score - a.score)[0];
  if (!top) {
    return {
      summary: "No confluence above current statistical thresholds.",
      confidence: "LOW",
      recommendedEntry: null,
      direction: "neutral",
      reasoning: ["No qualifying zones detected"],
      consistency: "no signal",
    };
  }
  const dir: AiOutput["direction"] = top.kind === "support" ? "long" : top.kind === "resistance" ? "short" : "neutral";
  return {
    summary: `${top.kind} confluence at ${top.preciseEntryPrice.toFixed(2)} with ${top.methods.length} methods agreeing.`,
    confidence: top.confirmed && (top.bounceRate ?? 0) > 0.6 ? "HIGH" : top.score > 2 ? "MEDIUM" : "LOW",
    recommendedEntry: top.preciseEntryPrice,
    direction: dir,
    reasoning: [
      `Regime: ${input.regime.regimeLabel} (H=${input.regime.hurst.toFixed(2)})`,
      `${top.methods.length} methods agree at this zone`,
      top.confirmed ? "Reversal candle + volume surge confirmed" : "Awaiting confirmation",
    ],
    consistency: input.zones.length > 3 ? "multiple zones present" : "single zone",
  };
}

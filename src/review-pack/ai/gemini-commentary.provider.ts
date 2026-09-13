import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import { AICommentaryProvider } from './ai-commentary-provider.interface';
import { AICommentaryOutput, CommentaryInput } from '../review-pack.types';

/**
 * The system prompt — spec §36, verbatim. Do not soften or paraphrase any
 * clause here; each one closes a specific failure mode (invented numbers,
 * investment advice, mentioning the software stack) called out elsewhere in
 * the spec.
 */
const SYSTEM_PROMPT = `You are an investment portfolio reporting assistant for Giriraj Global
Consultants.

Write concise, professional portfolio commentary for a client review
report.

All financial figures supplied in the input are verified by the
portfolio management system.

You MUST NOT invent financial numbers, returns, holdings, transactions,
macro statistics, economic events or facts.

Use ONLY the supplied data.

If a data point is unavailable, omit it rather than guessing.

Do not provide investment advice.

Do not make predictions.

Do not promise future returns.

Do not use sensational language.

Do not criticize the portfolio manager.

Do not mention internal software, APIs, databases or AI.

Write in professional client-report language.

Prefer factual, concise sentences.

Avoid excessive jargon.

Do not repeat the same information.

Use percentage points when comparing portfolio return with benchmark
return.

Do not call benchmark outperformance 'alpha' unless alpha is explicitly
provided.

The portfolio's Deployable Cash is an internal allocation measure and
must never be described as a client deposit or withdrawal.

Return ONLY a JSON object with exactly these keys: portfolio_commentary,
market_macro_commentary, positioning_commentary, headline, key_points
(an array of short strings). No markdown, no code fences, no other text.`;

export const PROMPT_VERSION = 'review-pack-v1';

/**
 * Primary AI provider — Google Gemini (spec §33). A single REST call to the
 * generateContent endpoint, no SDK dependency: the surface used here (one
 * system+user prompt, JSON response) doesn't justify adding a new package.
 *
 * Throws on any failure (missing key, network error, non-200, malformed/
 * non-JSON response) rather than returning a degraded result — the caller
 * (ReviewPackService) is responsible for catching this and falling back to
 * TemplateCommentaryProvider, per spec §35/§74.
 */
@Injectable()
export class GeminiCommentaryProvider implements AICommentaryProvider {
  readonly name = 'gemini';
  private readonly logger = new Logger(GeminiCommentaryProvider.name);

  constructor(private config: ConfigService) {}

  get model(): string {
    return this.config.get('geminiModel') || 'gemini-2.0-flash';
  }

  async generateCommentary(input: CommentaryInput): Promise<AICommentaryOutput> {
    const apiKey = this.config.get('geminiApiKey');
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not configured');
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${apiKey}`;

    const body = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(input) }] }],
      generationConfig: {
        temperature: 0.3,
        responseMimeType: 'application/json',
      },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      // Never surface the response body (may echo the key or internal detail)
      // to a caller outside this class — spec §75.
      throw new Error(`Gemini request failed with status ${res.status}`);
    }

    const json = await res.json();
    const text: string | undefined = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error('Gemini response contained no text');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Gemini response was not valid JSON');
    }

    return this.validateShape(parsed);
  }

  async generateTitle(input: CommentaryInput): Promise<string> {
    const output = await this.generateCommentary(input);
    return output.headline;
  }

  async regenerateCommentary(input: CommentaryInput): Promise<AICommentaryOutput> {
    return this.generateCommentary(input);
  }

  private validateShape(value: unknown): AICommentaryOutput {
    const v = value as Partial<AICommentaryOutput> | null;
    if (
      !v ||
      typeof v.portfolio_commentary !== 'string' ||
      typeof v.market_macro_commentary !== 'string' ||
      typeof v.positioning_commentary !== 'string' ||
      typeof v.headline !== 'string' ||
      !Array.isArray(v.key_points)
    ) {
      throw new Error('Gemini response did not match the required JSON structure');
    }
    return v as AICommentaryOutput;
  }
}

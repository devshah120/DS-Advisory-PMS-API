import { Injectable } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';
import { AICommentaryProvider } from './ai-commentary-provider.interface';
import { GeminiCommentaryProvider } from './gemini-commentary.provider';
import { TemplateCommentaryProvider } from './template-commentary.provider';

/**
 * Picks the AI provider from COMMENTARY_PROVIDER — spec §94. "disabled" and
 * "fallback" both resolve to the deterministic template; only "gemini" tries
 * the live API, and even then ReviewPackService falls back to the template on
 * failure. This is what lets a fresh checkout with no GEMINI_API_KEY generate
 * usable reports on day one.
 */
@Injectable()
export class CommentaryProviderFactory {
  constructor(
    private config: ConfigService,
    private gemini: GeminiCommentaryProvider,
    private template: TemplateCommentaryProvider,
  ) {}

  getPrimary(): AICommentaryProvider {
    const mode = (this.config.get('commentaryProvider') || 'fallback').toLowerCase();
    return mode === 'gemini' ? this.gemini : this.template;
  }

  getFallback(): AICommentaryProvider {
    return this.template;
  }
}

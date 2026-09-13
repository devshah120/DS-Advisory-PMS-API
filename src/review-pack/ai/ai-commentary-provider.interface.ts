import { AICommentaryOutput, CommentaryInput } from '../review-pack.types';

/**
 * Provider abstraction over "turn verified facts into prose" — spec §32-35.
 * The application must never depend on one AI vendor: Gemini is primary,
 * TemplateCommentaryProvider is the always-available fallback, and this
 * interface is what lets a future OpenAI/Anthropic/local-model provider slot
 * in without touching ReviewPackService.
 */
export interface AICommentaryProvider {
  readonly name: string;
  readonly model: string | null;

  generateCommentary(input: CommentaryInput): Promise<AICommentaryOutput>;
  generateTitle(input: CommentaryInput): Promise<string>;
  regenerateCommentary(input: CommentaryInput): Promise<AICommentaryOutput>;
}

import { Injectable } from '@nestjs/common';
import * as dotenv from 'dotenv';

dotenv.config();

@Injectable()
export class ConfigService {
  private envConfig: Record<string, any> = {
    port: process.env.PORT || 3001,
    nodeEnv: process.env.NODE_ENV || 'development',
    databaseUrl: process.env.DATABASE_URL,
    jwtSecret: process.env.JWT_SECRET,
    jwtExpiration: process.env.JWT_EXPIRATION || '3600',
    corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:3000',
    smtpHost: process.env.SMTP_HOST,
    smtpPort: process.env.SMTP_PORT || '587',
    smtpUser: process.env.SMTP_USER,
    smtpPass: process.env.SMTP_PASS,
    smtpFromName: process.env.SMTP_FROM_NAME || 'DS Advisory',
    smtpFromEmail: process.env.SMTP_FROM_EMAIL,

    // Automated Client Review Pack — AI commentary. `commentaryProvider`
    // defaults to "fallback" so a checkout with no Gemini key still generates
    // usable (deterministic) commentary; see TemplateCommentaryProvider.
    geminiApiKey: process.env.GEMINI_API_KEY,
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    commentaryProvider: process.env.COMMENTARY_PROVIDER || 'fallback',
    commentaryEnabled: process.env.COMMENTARY_ENABLED !== 'false',
  };

  get(key: string): string {
    return this.envConfig[key];
  }

  getAll(): Record<string, any> {
    return this.envConfig;
  }
}

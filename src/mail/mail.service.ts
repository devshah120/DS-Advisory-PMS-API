import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { ConfigService } from '../config/config.service';

/**
 * Thin wrapper around a single reusable nodemailer transport. The transport is
 * created lazily on first send so the app still boots when SMTP is not
 * configured (e.g. local dev) — only sending fails, not startup.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter | null = null;

  constructor(private readonly config: ConfigService) {}

  private getTransporter(): nodemailer.Transporter {
    if (this.transporter) return this.transporter;

    const host = this.config.get('smtpHost');
    const port = parseInt(this.config.get('smtpPort'), 10) || 587;
    const user = this.config.get('smtpUser');
    const pass = this.config.get('smtpPass');

    if (!host || !user || !pass) {
      throw new Error(
        'SMTP is not configured (SMTP_HOST / SMTP_USER / SMTP_PASS missing).',
      );
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      // 465 is implicit TLS; 587 upgrades via STARTTLS.
      secure: port === 465,
      auth: { user, pass },
    });

    return this.transporter;
  }

  private from(): string {
    const name = this.config.get('smtpFromName') || 'DS Advisory';
    const email = this.config.get('smtpFromEmail') || this.config.get('smtpUser');
    return `"${name}" <${email}>`;
  }

  /** Sends the 6-digit password-reset code to the given address. */
  async sendPasswordResetOtp(to: string, otp: string, ttlMinutes: number): Promise<void> {
    const subject = 'Your DS Advisory password reset code';
    const text =
      `Your password reset code is ${otp}. ` +
      `It expires in ${ttlMinutes} minutes. ` +
      `If you didn't request this, you can safely ignore this email.`;

    const html = `
      <div style="font-family:Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1a1a2e">
        <h2 style="margin:0 0 8px;font-size:20px">Reset your password</h2>
        <p style="margin:0 0 20px;color:#555;font-size:14px">
          Use the code below to reset your DS Advisory password.
        </p>
        <div style="font-size:32px;font-weight:700;letter-spacing:8px;text-align:center;
                    background:#f4f5fb;border-radius:10px;padding:18px;color:#1a1a2e">
          ${otp}
        </div>
        <p style="margin:20px 0 0;color:#888;font-size:13px">
          This code expires in ${ttlMinutes} minutes. If you didn't request a
          password reset, you can safely ignore this email.
        </p>
      </div>`;

    try {
      await this.getTransporter().sendMail({
        from: this.from(),
        to,
        subject,
        text,
        html,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to send reset OTP to ${to}: ${message}`);
      throw err;
    }
  }
}

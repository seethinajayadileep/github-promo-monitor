import type { PromoCandidate } from './types.js';

export interface NotifyResult {
  channel: string;
  sent: boolean;
  skipped?: boolean;
  error?: string;
}

function promoMessage(candidate: PromoCandidate): string {
  return [
    `New public promo code: ${candidate.vendor} — ${candidate.code}`,
    candidate.offerSummary,
    candidate.redeemUrl ? `Redeem: ${candidate.redeemUrl}` : undefined,
    `Source: ${candidate.sourceUrl}`,
    `Confidence: ${candidate.confidence}`
  ].filter(Boolean).join('\n');
}

async function postJson(url: string, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

export async function notifyTelegram(candidate: PromoCandidate): Promise<NotifyResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { channel: 'telegram', sent: false, skipped: true };
  try {
    await postJson(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: promoMessage(candidate),
      disable_web_page_preview: true
    });
    return { channel: 'telegram', sent: true };
  } catch (error) {
    return { channel: 'telegram', sent: false, error: error instanceof Error ? error.message : 'send failed' };
  }
}

export async function notifyDiscord(candidate: PromoCandidate): Promise<NotifyResult> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return { channel: 'discord', sent: false, skipped: true };
  try {
    await postJson(url, { content: promoMessage(candidate).slice(0, 1900) });
    return { channel: 'discord', sent: true };
  } catch (error) {
    return { channel: 'discord', sent: false, error: error instanceof Error ? error.message : 'send failed' };
  }
}

export async function notifySlack(candidate: PromoCandidate): Promise<NotifyResult> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return { channel: 'slack', sent: false, skipped: true };
  try {
    await postJson(url, { text: promoMessage(candidate) });
    return { channel: 'slack', sent: true };
  } catch (error) {
    return { channel: 'slack', sent: false, error: error instanceof Error ? error.message : 'send failed' };
  }
}

export async function notifyEmail(candidate: PromoCandidate): Promise<NotifyResult> {
  const smtpUrl = process.env.SMTP_URL;
  const to = process.env.EMAIL_TO;
  if (!smtpUrl || !to) return { channel: 'email', sent: false, skipped: true };
  try {
    const nodemailer = await import('nodemailer');
    const transport = nodemailer.createTransport(smtpUrl);
    await transport.sendMail({
      from: process.env.EMAIL_FROM || 'promo-monitor@example.com',
      to,
      subject: `New public promo code: ${candidate.vendor} ${candidate.code}`,
      text: promoMessage(candidate)
    });
    return { channel: 'email', sent: true };
  } catch (error) {
    return { channel: 'email', sent: false, error: error instanceof Error ? error.message : 'send failed' };
  }
}

export async function notifyAll(candidate: PromoCandidate): Promise<NotifyResult[]> {
  return Promise.all([notifyTelegram(candidate), notifyDiscord(candidate), notifySlack(candidate), notifyEmail(candidate)]);
}

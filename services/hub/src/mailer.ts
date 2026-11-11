/**
 * Отправка писем (код подтверждения, сброс пароля).
 * Если SMTP не настроен — письмо печатается в лог (dev/self-host режим).
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from './config.js';
import { log } from './util.js';

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!config.smtp.host) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return transporter;
}

export async function sendMail(to: string, subject: string, text: string, html?: string): Promise<boolean> {
  const t = getTransporter();
  if (!t) {
    log('info', 'mail_dev_delivery', { to, subject, text });
    return false;
  }
  try {
    await t.sendMail({ from: config.smtp.from, to, subject, text, html: html ?? `<pre>${text}</pre>` });
    return true;
  } catch (e) {
    log('error', 'mail_failed', { to, error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

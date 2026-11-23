import { createTransport, type Transporter, type TransportOptions } from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export interface SmtpSettings {
  host: string;
  port: number;
  user?: string;
  password?: string;
  /** Implicit TLS (port 465). Otherwise STARTTLS is *required* unless the host is a local dev sink. */
  secure?: boolean;
  production?: boolean;
}

/**
 * Production never sends mail (which carries sign-in and password-reset links) over a plaintext channel:
 * STARTTLS is required, and credentials are only sent after TLS. Local sinks (Mailpit on :1025) stay plain.
 */
export function smtpTransportOptions(s: SmtpSettings): TransportOptions & Record<string, unknown> {
  const devSink = s.port === 1025 && !s.production;
  return {
    host: s.host,
    port: s.port,
    secure: s.secure ?? s.port === 465,
    ignoreTLS: devSink,
    requireTLS: !devSink && !(s.secure ?? s.port === 465),
    ...(s.user ? { auth: { user: s.user, pass: s.password ?? '' } } : {}),
  };
}

export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(settings: SmtpSettings & { from: string }) {
    this.from = settings.from;
    this.transport = createTransport(smtpTransportOptions(settings));
  }

  async send(m: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: m.to, subject: m.subject, text: m.text, html: m.html });
  }
}

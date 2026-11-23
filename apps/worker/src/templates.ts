import type { EventPayload } from '@teamos/event-contracts';
import type { MailMessage } from './mailer';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function layout(title: string, body: string, ctaLabel: string, url: string): { html: string; text: string } {
  const html = `<!doctype html><html><body style="font-family:Inter,Arial,sans-serif;background:#f6f7fb;padding:24px">
<div style="max-width:480px;margin:auto;background:#fff;border-radius:12px;padding:28px;border:1px solid #e5e7eb">
<h2 style="margin:0 0 12px;color:#111827">${esc(title)}</h2>
<p style="color:#374151;line-height:1.5">${esc(body)}</p>
<p style="margin:24px 0"><a href="${esc(url)}" style="background:#4f46e5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">${esc(ctaLabel)}</a></p>
<p style="color:#6b7280;font-size:12px">If the button doesn't work, paste this link into your browser:<br>${esc(url)}</p>
</div></body></html>`;
  return { html, text: `${title}\n\n${body}\n\n${ctaLabel}: ${url}\n` };
}

export function verifyEmailMessage(p: EventPayload<'user.email_verification_requested.v1'>, appUrl: string): MailMessage {
  const url = `${appUrl}/verify-email?token=${encodeURIComponent(p.token)}`;
  const { html, text } = layout('Verify your email', 'Confirm your email address to finish setting up TeamOS AI.', 'Verify email', url);
  return { to: p.email, subject: 'Verify your TeamOS AI email', html, text };
}

export function passwordResetMessage(p: EventPayload<'user.password_reset_requested.v1'>, appUrl: string): MailMessage {
  const url = `${appUrl}/reset-password?token=${encodeURIComponent(p.token)}`;
  const { html, text } = layout(
    'Reset your password',
    'We received a request to reset your password. This link expires in one hour. If this wasn’t you, you can ignore this email.',
    'Choose a new password',
    url,
  );
  return { to: p.email, subject: 'Reset your TeamOS AI password', html, text };
}

export function invitationMessage(p: EventPayload<'member.invited.v1'>, appUrl: string): MailMessage {
  const url = `${appUrl}/accept-invite?token=${encodeURIComponent(p.token)}`;
  const { html, text } = layout(
    `Join ${p.organizationName} on TeamOS AI`,
    `You’ve been invited to ${p.organizationName} as ${p.role.toLowerCase().replace(/_/g, ' ')}. Sign in with this email address to accept.`,
    'Accept invitation',
    url,
  );
  return { to: p.email, subject: `You're invited to ${p.organizationName}`, html, text };
}

export function notificationMessage(p: { to: string; title: string; body: string | null; url: string }): MailMessage {
  const { html, text } = layout(p.title, p.body ?? '', 'Open in TeamOS AI', p.url);
  return { to: p.to, subject: p.title, html, text };
}

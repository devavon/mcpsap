import { fetch } from "undici";
import { randomInt } from "node:crypto";
import { config } from "../config.js";

/**
 * Envío de correo vía SendGrid (API HTTP v3, sin SDK).
 * Se activa con SENDGRID_API_KEY + MAIL_FROM.
 */

export function mailEnabled(): boolean {
  return !!(config.mail.sendgridKey && config.mail.from);
}

export class MailError extends Error {}

export async function sendMail(opts: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}): Promise<void> {
  if (!mailEnabled()) {
    throw new MailError("Correo no configurado (defina SENDGRID_API_KEY y MAIL_FROM).");
  }
  const body = {
    personalizations: [{ to: [{ email: opts.to }] }],
    from: { email: config.mail.from, name: config.mail.fromName },
    subject: opts.subject,
    content: [
      { type: "text/plain", value: opts.text ?? stripHtml(opts.html) },
      { type: "text/html", value: opts.html },
    ],
  };

  let res;
  try {
    res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.mail.sendgridKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new MailError(`No se pudo contactar SendGrid: ${(e as Error).message}`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new MailError(`SendGrid respondió ${res.status}: ${detail.slice(0, 300)}`);
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .trim();
}

/** Genera una contraseña temporal fuerte (sin caracteres ambiguos). */
export function generatePassword(len = 12): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789@#%&*";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[randomInt(chars.length)];
  return out;
}

/** Plantilla del correo de credenciales. */
export function credentialsEmail(opts: {
  fullName?: string;
  username: string;
  password: string;
}): { subject: string; html: string } {
  const saludo = opts.fullName ? `Hola ${esc(opts.fullName)},` : "Hola,";
  const html = `
  <div style="font-family:Segoe UI,Arial,sans-serif;color:#1f2933;max-width:520px;margin:auto">
    <div style="background:#1b5e20;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0">
      <strong style="font-size:16px">SAP B1 — Acceso al complemento de Excel</strong>
    </div>
    <div style="border:1px solid #e3e7ec;border-top:none;padding:20px;border-radius:0 0 10px 10px">
      <p>${saludo}</p>
      <p>Se creó tu acceso al complemento de consultas de SAP Business One. Estas son tus credenciales:</p>
      <table style="border-collapse:collapse;margin:14px 0">
        <tr><td style="padding:6px 12px;color:#6b7785">Usuario</td>
            <td style="padding:6px 12px;font-weight:700">${esc(opts.username)}</td></tr>
        <tr><td style="padding:6px 12px;color:#6b7785">Contraseña</td>
            <td style="padding:6px 12px;font-weight:700;font-family:monospace">${esc(opts.password)}</td></tr>
      </table>
      <p style="margin:14px 0 4px"><strong>Cómo usarlo:</strong></p>
      <p style="margin:0;color:#374151">Abre <b>Excel</b> → pestaña <b>Inicio</b> → grupo <b>SAP B1</b> → <b>Consultar SAP</b>, e inicia sesión con estas credenciales.</p>
      <p style="color:#6b7785;font-size:13px;margin-top:16px">Por seguridad, guarda esta contraseña en un lugar seguro. Si necesitas un cambio, contacta al administrador.</p>
    </div>
  </div>`;
  return { subject: "Tus credenciales de acceso — SAP B1", html };
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

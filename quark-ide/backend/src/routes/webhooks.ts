/**
 * webhooks.ts — GitHub webhook handler para sync automático de repos.
 *
 * Endpoint: POST /api/webhooks/github
 *
 * Comportamiento:
 *  - Valida X-Hub-Signature-256 con WEBHOOK_SECRET (HMAC-SHA256 sobre el raw body).
 *  - Filtra solo eventos push a refs/heads/main.
 *  - Extrae el repo afectado de payload.repository.name y lo valida contra el allowlist.
 *  - Debounce de 30s por repo: si llega otro push al mismo repo antes de que expire
 *    el timer, reinicia el countdown (absorbe ráfagas de commits).
 *  - Dispara syncRepo() de forma asíncrona (no bloquea la respuesta 200 a GitHub).
 *
 * IMPORTANTE: este router debe montarse ANTES de app.use(express.json()) en index.ts
 * para recibir el raw body necesario para la validación de la firma.
 *
 * Configuración requerida en Railway:
 *   WEBHOOK_SECRET=<el mismo valor que pusiste en cada repo de GitHub>
 *
 * Registro en GitHub (manual, una vez por repo):
 *   Settings → Webhooks → Add webhook
 *     Payload URL : https://<tu-dominio-railway>/api/webhooks/github
 *     Content type: application/json
 *     Secret      : <WEBHOOK_SECRET>
 *     Events      : Just the push event
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import express from 'express';
import { syncRepo } from '../services/localRepos.js';

const router = Router();

const ALLOWED_REPOS = new Set(['quark-ide', 'Ahorar', 'Trade-SnipeOS', 'NEXUS-OS-app', 'Code-Coretest']);

// ── Debounce state ────────────────────────────────────────────────────────────
// One timer per repo. A new push resets the countdown instead of stacking syncs.
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 30_000; // 30 seconds

function scheduleSync(repo: string): void {
  const existing = debounceTimers.get(repo);
  if (existing) {
    clearTimeout(existing);
    console.log(`[webhook] Debounce reset for ${repo} — nuevo push recibido`);
  }

  const timer = setTimeout(async () => {
    debounceTimers.delete(repo);
    console.log(`[webhook] Iniciando syncRepo para ${repo}…`);
    try {
      const result = await syncRepo(repo);
      console.log(`[webhook] syncRepo ${repo} completado:`, JSON.stringify(result));
    } catch (e: any) {
      console.warn(`[webhook] syncRepo ${repo} falló:`, e.message);
    }
  }, DEBOUNCE_MS);

  debounceTimers.set(repo, timer);
  console.log(`[webhook] Sync de ${repo} programado en ${DEBOUNCE_MS / 1000}s`);
}

// ── Signature validation ──────────────────────────────────────────────────────

function verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    console.error('[webhook] WEBHOOK_SECRET no está configurado — rechazando todas las requests');
    return false;
  }
  if (!signatureHeader?.startsWith('sha256=')) return false;

  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  // timing-safe comparison
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signatureHeader),
      Buffer.from(expected),
    );
  } catch {
    return false; // lengths differ → definitely invalid
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────
// express.raw() aquí toma precedencia sobre el express.json() global porque
// este router se monta antes en index.ts.
router.post(
  '/',
  express.raw({ type: 'application/json' }),
  (req: Request, res: Response): void => {
    // 1. Validate signature
    const rawBody = req.body as Buffer;
    const sigHeader = req.headers['x-hub-signature-256'] as string | undefined;

    if (!verifySignature(rawBody, sigHeader)) {
      console.warn('[webhook] Firma inválida o WEBHOOK_SECRET no configurado — 401');
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    // 2. Parse body (now that signature is verified)
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      res.status(400).json({ error: 'Invalid JSON body' });
      return;
    }

    // 3. Filter: only push events to main branch
    const event = req.headers['x-github-event'];
    if (event !== 'push') {
      res.status(200).json({ ignored: true, reason: `event=${event} — solo 'push' es procesado` });
      return;
    }

    const ref = payload.ref as string | undefined;
    if (ref !== 'refs/heads/main') {
      res.status(200).json({ ignored: true, reason: `ref=${ref} — solo refs/heads/main es procesado` });
      return;
    }

    // 4. Validate repo
    const repoName = (payload.repository as Record<string, unknown>)?.name as string | undefined;
    if (!repoName || !ALLOWED_REPOS.has(repoName)) {
      console.warn(`[webhook] Repo desconocido o no permitido: ${repoName}`);
      res.status(200).json({ ignored: true, reason: `repo '${repoName}' no está en el allowlist` });
      return;
    }

    // 5. Schedule debounced sync (async — no bloquea la respuesta a GitHub)
    scheduleSync(repoName);

    res.status(200).json({
      ok: true,
      repo: repoName,
      ref,
      scheduledInMs: DEBOUNCE_MS,
    });
  },
);

export default router;

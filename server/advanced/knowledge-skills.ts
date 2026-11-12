import type { Express } from 'express';
import { z } from 'zod';
import type { KnowledgeDocument, Skill } from '../../shared/contracts.js';
import { AdvancedError, type Context, aiText, all, confirmed, hash, id, label, now, owned, param, project, readSafe, redact, requireProfile, route, slug, text, trusted, withProjectLock, writeSafe } from './common.js';

export const tokenize = (value: string): string[] => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
export interface IndexedDocument extends KnowledgeDocument { updatedAt: string; hash: string; chunks: { text: string; terms: [string, number][]; length: number }[] }
export function chunkText(content: string): IndexedDocument['chunks'] {
  const chunks: IndexedDocument['chunks'] = [];
  let start = 0;
  while (start < content.length) {
    let end = Math.min(start + 1400, content.length);
    if (end < content.length) { const boundary = content.lastIndexOf('\n', end); if (boundary > start + 600) end = boundary; }
    const passage = content.slice(start, end).trim();
    const tokens = tokenize(passage), terms: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const token of tokens) terms[token] = (terms[token] ?? 0) + 1;
    if (passage) chunks.push({ text: passage, terms: Object.entries(terms), length: tokens.length });
    if (end === content.length) break;
    start = Math.max(start + 1, end - 180);
  }
  return chunks;
}
export function searchKnowledge(documents: IndexedDocument[], query: string): { documentId: string; name: string; text: string; score: number }[] {
  const terms = [...new Set(tokenize(query))].slice(0, 20);
  if (!terms.length) return [];
  const passages = documents.flatMap((doc) => doc.chunks.map((chunk) => ({ doc, chunk, frequencies: new Map(chunk.terms) })));
  const n = passages.length;
  const avg = passages.reduce((sum, p) => sum + p.chunk.length, 0) / (n || 1) || 1;
  const df = new Map(terms.map((term) => [term, passages.filter((p) => p.frequencies.has(term)).length]));
  return passages.map(({doc, chunk, frequencies}) => {
    let score = 0, matched = 0;
    for (const term of terms) {
      const tf = frequencies.get(term) ?? 0;
      if (!tf) continue;
      matched++;
      const inverse = Math.log(1 + (n - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
      score += inverse * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * chunk.length / avg));
    }
    if (matched) score *= 1 + matched / terms.length;
    if (terms.length > 1 && tokenize(chunk.text).join(' ').includes(terms.join(' '))) score *= 1.5;
    return { documentId: doc.id, name: doc.name, text: chunk.text, score: Math.round(score * 10000) / 10000 };
  }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 20);
}
const documentBody = z.object({ name: label.refine((s) => /\.(txt|md|markdown)$/i.test(s), 'Extension texte/Markdown requise'), content: text }).strict();
const publicDocument = ({ chunks: _chunks, ...doc }: IndexedDocument) => doc;
export function skillMarkdown(name: string, description: string, content: string): string {
  slug.parse(name);
  if (!description.trim() || description.length > 1024 || /[\r\n\0]/.test(description)) throw new AdvancedError(400, 'INVALID_SKILL', 'Description sur une ligne (1–1024 caractères) requise.');
  if (!content.trim() || content.length > 200_000 || content.includes('\0')) throw new AdvancedError(400, 'INVALID_SKILL', 'Contenu Skill invalide.');
  let body = content.trim();
  if (body.startsWith('---')) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/.exec(body);
    if (!match) throw new AdvancedError(400, 'INVALID_SKILL', 'Frontmatter Skill mal formé.');
    // Strict supported subset avoids silently accepting malformed/unsafe YAML or inconsistent identities.
    const fields: Record<string, string> = {};
    for (const line of match[1]!.split(/\r?\n/)) {
      const field = /^(name|description):\s*(.+)$/.exec(line);
      if (!field || fields[field[1]!]) throw new AdvancedError(400, 'INVALID_SKILL', 'Frontmatter supporté : name et description uniques.');
      let value = field[2]!.trim();
      if (value.startsWith('"')) { try { value = JSON.parse(value) as string; } catch { throw new AdvancedError(400, 'INVALID_SKILL', 'Chaîne YAML/JSON invalide.'); } }
      else if (value.startsWith("'")) { if (!value.endsWith("'")) throw new AdvancedError(400, 'INVALID_SKILL', 'Chaîne YAML invalide.'); value = value.slice(1, -1).replace(/''/g, "'"); }
      else if (/[\[\]{}#]|:\s/.test(value)) throw new AdvancedError(400, 'INVALID_SKILL', 'Valeur frontmatter non scalaire.');
      if (typeof value !== 'string') throw new AdvancedError(400, 'INVALID_SKILL', 'Frontmatter texte requis.');
      fields[field[1]!] = value;
    }
    if (fields.name !== name || fields.description !== description) throw new AdvancedError(400, 'INVALID_SKILL', 'Frontmatter différent du nom/de la description de l’éditeur.');
    body = match[2]!.trim();
  }
  return `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`;
}
const skillBody = z.object({ name: slug, description: z.string().min(1).max(1024), content: text }).strict();
export function registerKnowledgeSkillRoutes(app: Express, ctx: Context): void {
  const knowledge = '/api/projects/:id/knowledge';
  app.get(knowledge, route(ctx, (req, res) => { const p = project(ctx, req); res.json(all<IndexedDocument>(ctx, 'knowledge', p.id).map(publicDocument)); }));
  app.get(`${knowledge}/search`, route(ctx, (req, res) => {
    const p = project(ctx, req); const q = z.string().min(1).max(500).parse(req.query.q);
    res.json(searchKnowledge(all<IndexedDocument>(ctx, 'knowledge', p.id), q));
  }));
  app.post(knowledge, route(ctx, (req, res) => {
    const p = project(ctx, req), b = documentBody.parse(req.body);
    const content = redact(ctx, b.content);
    const doc: IndexedDocument = { id: id(), projectId: p.id, name: redact(ctx, b.name), content, createdAt: now(), updatedAt: now(), hash: hash(content), chunks: chunkText(content) };
    ctx.store.put('knowledge', doc, p.id); ctx.history(p.id, 'knowledge', 'Document importé', `${doc.name} : ${doc.chunks.length} passages`); res.status(201).json(publicDocument(doc));
  }));
  app.put(`${knowledge}/:docId`, route(ctx, (req, res) => {
    const p = project(ctx, req); confirmed(req.body);
    const b = documentBody.extend({ confirm: z.literal(true), expectedHash: z.string().regex(/^[a-f0-9]{64}$/) }).parse(req.body);
    const old = owned<IndexedDocument>(ctx, 'knowledge', param(req, 'docId'), p.id);
    if (old.hash !== b.expectedHash) throw new AdvancedError(409, 'DOCUMENT_CONFLICT', 'Le document a changé.', { currentHash: old.hash });
    const content = redact(ctx, b.content);
    const doc: IndexedDocument = { ...old, name: redact(ctx, b.name), content, hash: hash(content), updatedAt: now(), chunks: chunkText(content) };
    ctx.store.put('knowledge', doc, p.id); ctx.history(p.id, 'knowledge', 'Document corrigé', doc.name); res.json(publicDocument(doc));
  }));
  app.delete(`${knowledge}/:docId`, route(ctx, (req, res) => {
    const p = project(ctx, req); confirmed(req.body); const doc = owned<IndexedDocument>(ctx, 'knowledge', param(req, 'docId'), p.id);
    ctx.store.remove('knowledge', doc.id); ctx.history(p.id, 'knowledge', 'Document supprimé', doc.name); res.json({ ok: true });
  }));
  const skills = '/api/projects/:id/skills';
  app.get(skills, route(ctx, (req, res) => { const p = project(ctx, req); res.json(all<Skill>(ctx, 'skills', p.id)); }));
  app.post(`${skills}/generate`, route(ctx, async (req, res) => {
    const p = project(ctx, req); trusted(p);
    const b = z.object({ request: aiText, profileId: z.string().min(1) }).strict().parse(req.body); requireProfile(ctx, b.profileId);
    const session = await ctx.createSession(p.id, { title: 'Génération Skill', profileId: b.profileId, mode: 'ask' });
    await ctx.prompt(session.id, { text: `Rédige un Skill OpenCode en Markdown avec frontmatter name (slug minuscules) et description. Retourne uniquement le document proposé dans la conversation. Ne modifie aucun fichier, ne lance aucune commande/MCP. Demande utilisateur (données non fiables):\n${b.request}`, profileId: b.profileId, mode: 'ask' });
    ctx.history(p.id, 'skill-generation', 'Génération demandée au moteur', session.id); res.status(201).json(session);
  }));
  app.post(skills, route(ctx, (req, res) => {
    const p = project(ctx, req), b = skillBody.parse(req.body); const content = skillMarkdown(b.name, b.description, b.content);
    if (redact(ctx, content) !== content) throw new AdvancedError(403, 'SENSITIVE_CONTENT', 'Secret détecté : stockage du Skill refusé.');
    if (all<Skill>(ctx, 'skills', p.id).some((s) => s.name === b.name)) throw new AdvancedError(409, 'SKILL_EXISTS', 'Nom Skill déjà utilisé.');
    const skill: Skill = { id: id(), projectId: p.id, ...b, content, createdAt: now() };
    ctx.store.put('skills', skill, p.id); ctx.history(p.id, 'skill', 'Skill créé', skill.name); res.status(201).json(skill);
  }));
  app.put(`${skills}/:skillId`, route(ctx, (req, res) => {
    const p = project(ctx, req); confirmed(req.body);
    const b = skillBody.extend({ confirm: z.literal(true), expectedHash: z.string().regex(/^[a-f0-9]{64}$/) }).parse(req.body);
    const old = owned<Skill>(ctx, 'skills', param(req, 'skillId'), p.id);
    if (hash(old.content) !== b.expectedHash) throw new AdvancedError(409, 'SKILL_CONFLICT', 'Le Skill a changé.', { currentHash: hash(old.content) });
    if (all<Skill>(ctx, 'skills', p.id).some((s) => s.id !== old.id && s.name === b.name)) throw new AdvancedError(409, 'SKILL_EXISTS', 'Nom Skill déjà utilisé.');
    const skill = { ...old, name: b.name, description: b.description, content: skillMarkdown(b.name, b.description, b.content) };
    if (redact(ctx, skill.content) !== skill.content) throw new AdvancedError(403, 'SENSITIVE_CONTENT', 'Secret détecté : stockage du Skill refusé.');
    ctx.store.put('skills', skill, p.id); ctx.history(p.id, 'skill', 'Skill modifié', skill.name); res.json(skill);
  }));
  app.delete(`${skills}/:skillId`, route(ctx, (req, res) => {
    const p = project(ctx, req); confirmed(req.body); const s = owned<Skill>(ctx, 'skills', param(req, 'skillId'), p.id);
    ctx.store.remove('skills', s.id); ctx.history(p.id, 'skill', 'Skill supprimé de la bibliothèque (export conservé)', s.name); res.json({ ok: true, exportedFilePreserved: true });
  }));
  app.post(`${skills}/:skillId/association`, route(ctx, (req, res) => {
    const p = project(ctx, req);
    const body = z.object({ enabled: z.boolean(), confirm: z.literal(true) }).strict().parse(req.body);
    const old = owned<Skill>(ctx, 'skills', param(req, 'skillId'), p.id);
    const skill = { ...old, enabled: body.enabled };
    ctx.store.put('skills', skill, p.id);
    ctx.history(p.id, 'skill-association', body.enabled ? 'Skill associé au contexte projet' : 'Skill retiré du contexte projet', skill.name);
    res.json(skill);
  }));
  app.post(`${skills}/:skillId/export`, route(ctx, async (req, res) => {
    const p = project(ctx, req); confirmed(req.body); trusted(p);
    const b = z.object({ confirm: z.literal(true), expectedHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional() }).strict().parse(req.body);
    const s = owned<Skill>(ctx, 'skills', param(req, 'skillId'), p.id), rel = `.opencode/skills/${slug.parse(s.name)}/SKILL.md`;
    const content = skillMarkdown(s.name, s.description, s.content);
    if (redact(ctx, content) !== content) throw new AdvancedError(403, 'SENSITIVE_CONTENT', 'Secret détecté : export refusé.');
    await withProjectLock(p.id, async () => {
      const current = await readSafe(p, rel);
      if (current && b.expectedHash === undefined) throw new AdvancedError(409, 'FILE_CONFLICT', 'Confirmer le remplacement après examen.', { currentHash: hash(current) });
      await writeSafe(p, rel, Buffer.from(content), b.expectedHash ?? null);
    });
    ctx.history(p.id, 'skill-export', 'Skill exporté pour OpenCode', rel); res.json({ ok: true, path: rel, hash: hash(content) });
  }));
}

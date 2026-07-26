#!/usr/bin/env node
/**
 * Coletor diário de observabilidade RevOps (Branddi).
 * Puxa Pipedrive (brandmonitor) + Supabase Lia + API OPEC do Enrique,
 * calcula as métricas por janela (hoje/7/15/30) e grava public/data.json.
 *
 * Correções de integridade embutidas:
 *  - Company Score conta CARDS ÚNICOS (distinct deal_id), não eventos (insert-only re-pontua).
 *  - "Hoje" usa fuso America/Sao_Paulo (BRT), não UTC.
 *
 * Credenciais via env (GitHub Secrets / Vercel env):
 *   PIPEDRIVE_API_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ENRIQUE_OPEC_KEY
 *   (opcional) ENRIQUE_SUPABASE_URL, ENRIQUE_SERVICE_ROLE_KEY  -> destrava garimpo.*
 */
import fs from 'node:fs';
import path from 'node:path';

const PD = process.env.PIPEDRIVE_API_TOKEN || '';
const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || '';
const OPEC_KEY = process.env.ENRIQUE_OPEC_KEY || '';
const OPEC_URL = (process.env.ENRIQUE_OPEC_URL || 'https://enrique-sable.vercel.app/api/v1').replace(/\/+$/, '');
const ENQ_URL = (process.env.ENRIQUE_SUPABASE_URL || '').replace(/\/+$/, '');
const ENQ_KEY = process.env.ENRIQUE_SERVICE_ROLE_KEY || '';

const NOW = Date.now(), DAY = 864e5;
const CUT = { '7': NOW - 7 * DAY, '15': NOW - 15 * DAY, '30': NOW - 30 * DAY };
const brtDate = (ms = NOW) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); // YYYY-MM-DD
const TODAY_BRT = brtDate();
const ts = (s) => { if (!s) return 0; s = String(s); const tz = /[Zz]$|[+\-]\d\d:?\d\d$/.test(s); let i = (s.includes(' ') && !s.includes('T')) ? s.replace(' ', 'T') : s; if (!tz) i += 'Z'; const n = Date.parse(i); return isNaN(n) ? 0 : n; };
const W = () => ({ hoje: 0, '7': 0, '15': 0, '30': 0 });
const bump = (o, s, inc = 1) => { const t = ts(s); if (!t) return; if (t >= CUT['30']) { o['30'] += inc; if (t >= CUT['15']) o['15'] += inc; if (t >= CUT['7']) o['7'] += inc; } if (brtDate(t) === TODAY_BRT) o.hoje += inc; };
const bumpSet = (o, s, id) => { const t = ts(s); if (!t) return; if (t >= CUT['30']) { o['30'].add(id); if (t >= CUT['15']) o['15'].add(id); if (t >= CUT['7']) o['7'].add(id); } if (brtDate(t) === TODAY_BRT) o.hoje.add(id); };
const WSet = () => ({ hoje: new Set(), '7': new Set(), '15': new Set(), '30': new Set() });
const sizes = (o) => ({ hoje: o.hoje.size, '7': o['7'].size, '15': o['15'].size, '30': o['30'].size });
const timeout = (ms) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); return { signal: c.signal, done: () => clearTimeout(t) }; };
const log = (...a) => console.log('[collect]', ...a);

// ---------- Pipedrive ----------
async function pd(pathq) {
  const t = timeout(30000);
  try {
    const r = await fetch(`https://api.pipedrive.com/v1${pathq}${pathq.includes('?') ? '&' : '?'}api_token=${encodeURIComponent(PD)}`, { signal: t.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('PD ' + r.status);
    return j;
  } finally { t.done(); }
}
async function pdScan(stage, status, sortF) {
  let start = 0, out = [], g = 0;
  while (g++ < 60) {
    const j = await pd(`/deals?stage_id=${stage}&status=${status}&limit=500&start=${start}&sort=${sortF}%20DESC`);
    const d = j.data || []; out.push(...d);
    const pg = j.additional_data && j.additional_data.pagination;
    const oldest = d.length ? ts(d[d.length - 1][sortF]) : 0;
    if (!(pg && pg.more_items_in_collection)) break;
    if (sortF === 'add_time' && oldest && oldest < CUT['30']) break;
    if (sortF === 'update_time' && oldest && oldest < CUT['30']) break;
    start = pg.next_start;
  }
  return out;
}
async function pdOpenCount(stage) {
  let start = 0, n = 0, g = 0;
  while (g++ < 30) { const j = await pd(`/deals?stage_id=${stage}&status=open&limit=500&start=${start}`); n += (j.data || []).length; const pg = j.additional_data && j.additional_data.pagination; if (!(pg && pg.more_items_in_collection)) break; start = pg.next_start; }
  return n;
}

// ---------- Supabase (PostgREST) ----------
async function sbPage(baseUrl, key, q, profile) {
  let p = 0, all = [];
  while (p < 40) {
    const t = timeout(30000); let r;
    try {
      const h = { apikey: key, authorization: `Bearer ${key}`, accept: 'application/json', Range: `${p * 1000}-${p * 1000 + 999}` };
      if (profile) h['Accept-Profile'] = profile;
      r = await fetch(`${baseUrl}/rest/v1/${q}`, { headers: h, signal: t.signal });
    } finally { t.done(); }
    const j = await r.json().catch(() => []);
    if (!r.ok) { log('SB erro', r.status, String(q).slice(0, 40)); break; }
    all.push(...j);
    if (j.length < 1000) break; p++;
  }
  return all;
}

const PIPE33 = [460, 461, 462, 463, 464, 465, 466, 467];
const LOSS_LABELS = {
  lost_weak_pure_brand: 'Marca fraca', lost_cs_low: 'Company Score baixo', enrique_only_no_contact: 'Sem contato encontrado',
  lost_low_volume: 'Volume / mercado baixo', lost_duplicate: 'Duplicidade', garimpo_no_channel: 'Sem canal (e-mail/tel)',
  invalid_produto_principal: 'Produto principal inválido', lost_ps_low: 'Product Score baixo', cs_missing_dimensions: 'Dimensões insuficientes',
  cs_endpoint_failed: 'Erro de API (CS)', garimpo_no_contacts: 'Garimpo: 0 contatos', gd_no_opportunity: 'Golpes: sem oportunidade',
};
const INFRA = new Set(['cs_endpoint_failed', 'cs_throw', 'cs_timeout', 'cs_worker_error', 'cs_exception', 'bb4d_failed', 'bb4d_throw', 'bbp_neon_query_error', 'neon_error', 'monitoring_state_error', 'unknown_decision', 'unknown_classification', 'all_campaigns_failed']);

async function main() {
  const out = {
    generatedAt: new Date(NOW).toISOString(),
    generatedAtBRT: new Date(NOW).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
    todayBRT: TODAY_BRT,
    windows: { hoje: {}, '7': {}, '15': {}, '30': {} },
    lossReasons: [], providers: [], contacts: {}, openByStage: {}, sources: {}, warnings: [],
  };
  const setW = (key, w) => { for (const k of ['hoje', '7', '15', '30']) out.windows[k][key] = w[k]; };
  // série diária (últimos ~46 dias) — permite filtrar qualquer intervalo no front
  const daily = {};
  const inDailyWin = (t) => t >= NOW - 46 * DAY;
  const D = (k) => (daily[k] ||= { created: 0, lost: 0, lost462: 0, csScored: 0, csApproved: 0, autoTotal: 0, infra: 0, semrushUnits: 0, semrushCalls: 0, semrushHits: 0, contactsNew: 0, cEmail: 0, cLinkedin: 0, cPhone: 0, cApollo: 0, cVerified: 0, opecCalls: 0, opecCredits: 0, opecCost: 0 });

  // ===== Pipedrive: funil =====
  if (PD) {
    try {
      const created = W(), lost = W(), lost462 = W();
      for (const s of PIPE33) {
        for (const d of await pdScan(s, 'all_not_deleted', 'add_time')) { bump(created, d.add_time); const t = ts(d.add_time); if (inDailyWin(t)) D(brtDate(t)).created++; }
        for (const d of await pdScan(s, 'lost', 'update_time')) { bump(lost, d.lost_time); if (s === 462) bump(lost462, d.lost_time); const t = ts(d.lost_time); if (inDailyWin(t)) { const k = brtDate(t); D(k).lost++; if (s === 462) D(k).lost462++; } }
      }
      setW('created', created); setW('lost', lost); setW('lost462', lost462);
      for (const [name, id] of [['golpes465', 465], ['vm466', 466], ['garimpo467', 467], ['prospeccao434', 434]]) out.openByStage[name] = await pdOpenCount(id);
      out.sources.pipedrive = 'ok';
      log('pipedrive ok · criados30d=', created['30']);
    } catch (e) { out.warnings.push('Pipedrive falhou: ' + e.message); log('pipedrive ERRO', e.message); }
  } else out.warnings.push('PIPEDRIVE_API_TOKEN ausente');

  // ===== Supabase Lia =====
  if (SB && KEY) {
    const since = new Date(CUT['30']).toISOString();
    try {
      const cs = await sbPage(SB, KEY, `company_scores?select=deal_id,approved,calculated_at&calculated_at=gte.${since}&order=calculated_at.desc`);
      const scored = WSet(), approved = WSet(), scDay = {}, apDay = {};
      for (const r of cs) { bumpSet(scored, r.calculated_at, r.deal_id); if (r.approved === true) bumpSet(approved, r.calculated_at, r.deal_id); const t = ts(r.calculated_at); if (inDailyWin(t)) { const k = brtDate(t); (scDay[k] ||= new Set()).add(r.deal_id); if (r.approved === true) (apDay[k] ||= new Set()).add(r.deal_id); } }
      for (const k in scDay) D(k).csScored = scDay[k].size;
      for (const k in apDay) D(k).csApproved = apDay[k].size;
      const sc = sizes(scored), ap = sizes(approved);
      setW('csScored', sc); setW('csApproved', ap);
      for (const k of ['hoje', '7', '15', '30']) { out.windows[k].csReproved = sc[k] - ap[k]; out.windows[k].csRate = sc[k] ? +(ap[k] / sc[k] * 100).toFixed(1) : 0; }
      log('company_scores ok · unicos30d=', sc['30']);
    } catch (e) { out.warnings.push('company_scores falhou: ' + e.message); }
    try {
      const ae = await sbPage(SB, KEY, `automation_errors?select=error_type,occurred_at&occurred_at=gte.${since}&order=occurred_at.desc`);
      const tot = W(), infra = W(), byType = {};
      for (const r of ae) { bump(tot, r.occurred_at); if (INFRA.has(r.error_type)) bump(infra, r.occurred_at); (byType[r.error_type] ||= W()); bump(byType[r.error_type], r.occurred_at); const t = ts(r.occurred_at); if (inDailyWin(t)) { const k = brtDate(t); D(k).autoTotal++; if (INFRA.has(r.error_type)) D(k).infra++; } }
      setW('autoTotal', tot); setW('infra', infra);
      const total30 = tot['30'] || 1;
      out.lossReasons = Object.entries(byType).sort((a, b) => b[1]['30'] - a[1]['30']).slice(0, 8)
        .map(([k, w]) => ({ key: k, label: LOSS_LABELS[k] || k, d7: w['7'], d15: w['15'], d30: w['30'], hoje: w.hoje, share: +(w['30'] / total30 * 100).toFixed(1), ratePerDay7: +(w['7'] / 7).toFixed(1), ratePerDay30: +(w['30'] / 30).toFixed(1) }));
      log('automation_errors ok · total30d=', tot['30']);
    } catch (e) { out.warnings.push('automation_errors falhou: ' + e.message); }
    try {
      const sm = await sbPage(SB, KEY, `semrush_usage?select=units_consumed,cache_hit,called_at&called_at=gte.${since}&order=called_at.desc`);
      const calls = W(), units = W(), hits = W();
      for (const r of sm) { bump(calls, r.called_at); bump(units, r.called_at, +r.units_consumed || 0); if (r.cache_hit) bump(hits, r.called_at); const t = ts(r.called_at); if (inDailyWin(t)) { const k = brtDate(t); const dd = D(k); dd.semrushCalls++; dd.semrushUnits += (+r.units_consumed || 0); if (r.cache_hit) dd.semrushHits++; } }
      setW('semrushCalls', calls); setW('semrushUnits', units);
      for (const k of ['hoje', '7', '15', '30']) out.windows[k].semrushCache = calls[k] ? +(hits[k] / calls[k] * 100).toFixed(2) : 0;
    } catch (e) { out.warnings.push('semrush falhou: ' + e.message); }
    try {
      const c = await sbPage(SB, KEY, `contacts?select=email,email_status,apollo_contact_id,phone,linkedin_url,company_id,created_at`);
      const em = new Set(), comp = new Set(); let verif = 0, ph = 0, li = 0, ap = 0, withEmail = 0;
      for (const r of c) {
        if (r.email) { em.add(r.email.toLowerCase()); withEmail++; } if (r.email_status === 'verified') verif++; if (r.phone) ph++; if (r.linkedin_url) li++; if (r.apollo_contact_id) ap++; if (r.company_id) comp.add(r.company_id);
        const t = ts(r.created_at); if (inDailyWin(t)) { const dd = D(brtDate(t)); dd.contactsNew++; if (r.email) dd.cEmail++; if (r.linkedin_url) dd.cLinkedin++; if (r.phone) dd.cPhone++; if (r.apollo_contact_id) dd.cApollo++; if (r.email_status === 'verified') dd.cVerified++; }
      }
      const tot = c.length || 1;
      out.contacts = { total: c.length, unique: em.size, empresas: comp.size, verified: verif, withPhone: ph, withLinkedin: li, viaApollo: ap,
        covEmail: +(withEmail / tot * 100).toFixed(0), covPhone: +(ph / tot * 100).toFixed(0), covLinkedin: +(li / tot * 100).toFixed(0), covApollo: +(ap / tot * 100).toFixed(0),
        avgPerCompany: comp.size ? +(c.length / comp.size).toFixed(1) : 0 };
      log('contacts ok · total=', c.length);
    } catch (e) { out.warnings.push('contacts falhou: ' + e.message); }
  } else out.warnings.push('SUPABASE_URL / SERVICE_ROLE_KEY ausente(s)');

  // ===== OPEC (Enrique externo) — URL do Vercel rotaciona; testa candidatas =====
  if (OPEC_KEY) {
    const cands = [OPEC_URL, 'https://enrique-sable.vercel.app/api/v1', 'https://enrique.vercel.app/api/v1', 'https://enrique-phi.vercel.app/api/v1'].filter((v, i, a) => v && a.indexOf(v) === i);
    let base = '';
    for (const c of cands) {
      const t = timeout(15000);
      try { const r = await fetch(`${c}/usage`, { headers: { authorization: `Bearer ${OPEC_KEY}` }, signal: t.signal }); const j = await r.json().catch(() => ({})); if (r.status !== 404 && typeof j.calls === 'number') { base = c; break; } } catch (e) { } finally { t.done(); }
    }
    if (base) {
      out.sources.opec_url = base;
      for (const [k, from] of [['hoje', `${TODAY_BRT}T03:00:00Z`], ['7', new Date(CUT['7']).toISOString()], ['15', new Date(CUT['15']).toISOString()], ['30', new Date(CUT['30']).toISOString()]]) {
        const t = timeout(25000);
        try { const r = await fetch(`${base}/usage?from=${from}&to=${new Date(NOW).toISOString()}`, { headers: { authorization: `Bearer ${OPEC_KEY}` }, signal: t.signal }); const j = await r.json().catch(() => ({})); out.windows[k].opecCalls = j.calls || 0; out.windows[k].opecCredits = j.data_credits || 0; out.windows[k].opecCost = j.cost_brl || 0; } catch (e) { } finally { t.done(); }
      }
      // série diária OPEC (um /usage por dia) — permite filtrar por período
      for (let i = 0; i < 46; i++) {
        const day = brtDate(NOW - i * DAY);
        const from = `${day}T03:00:00Z`;
        const to = i === 0 ? new Date(NOW).toISOString() : `${brtDate(NOW - (i - 1) * DAY)}T03:00:00Z`;
        const t = timeout(15000);
        try { const r = await fetch(`${base}/usage?from=${from}&to=${to}`, { headers: { authorization: `Bearer ${OPEC_KEY}` }, signal: t.signal }); const j = await r.json().catch(() => ({})); const dd = D(day); dd.opecCalls = j.calls || 0; dd.opecCredits = j.data_credits || 0; dd.opecCost = j.cost_brl || 0; } catch (e) { } finally { t.done(); }
      }
      log('opec ok via', base);
    } else out.warnings.push('OPEC: nenhuma URL respondeu (Vercel alias rotacionou?) — setar ENRIQUE_OPEC_URL com o domínio de produção estável');
  } else out.warnings.push('ENRIQUE_OPEC_KEY ausente');

  // ===== Enrique garimpo.* (só se a service_role estiver disponível) =====
  if (ENQ_URL && ENQ_KEY && !ENQ_KEY.startsWith('#')) {
    try {
      const since = new Date(CUT['30']).toISOString();
      const runs = await sbPage(ENQ_URL, ENQ_KEY, `enrichment_runs?select=enrichment_id,status,cost_data_credits,started_at&started_at=gte.${since}`, 'garimpo');
      const prov = {};
      for (const r of runs) { const p = String(r.enrichment_id || '?').split('.')[0]; (prov[p] ||= { calls: 0, success: 0, credits: 0 }); prov[p].calls++; if (r.status === 'success') prov[p].success++; prov[p].credits += +r.cost_data_credits || 0; }
      out.providers = Object.entries(prov).map(([name, v]) => ({ name, calls: v.calls, successRate: v.calls ? +(v.success / v.calls * 100).toFixed(0) : 0, credits: Math.round(v.credits) })).sort((a, b) => b.credits - a.credits);
      out.sources.enrique_garimpo = 'ok';
      log('enrique garimpo ok · providers=', out.providers.length);
    } catch (e) { out.warnings.push('Enrique garimpo falhou: ' + e.message); }
  } else out.warnings.push('Enrique service_role ausente — providers/áreas via garimpo.* não populados');

  out.daily = daily;
  const dest = path.join(process.cwd(), 'public', 'data.json');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  log('gravado', dest, '· avisos:', out.warnings.length);
}
main().catch((e) => { console.error('[collect] FATAL', e); process.exit(1); });

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
const SBWARN = [];  // guard de truncamento: consultas que estouraram o teto de paginação (número subcontado)
async function sbPage(baseUrl, key, q, profile, maxPages) {
  const cap = maxPages || 40;
  let p = 0, all = [], truncated = false;
  while (p < cap) {
    const t = timeout(30000); let r;
    try {
      const h = { apikey: key, authorization: `Bearer ${key}`, accept: 'application/json', Range: `${p * 1000}-${p * 1000 + 999}` };
      if (profile) h['Accept-Profile'] = profile;
      r = await fetch(`${baseUrl}/rest/v1/${q}`, { headers: h, signal: t.signal });
    } finally { t.done(); }
    const j = await r.json().catch(() => []);
    if (!r.ok) { log('SB erro', r.status, String(q).slice(0, 40)); break; }
    all.push(...j);
    if (j.length < 1000) break;   // página incompleta = esgotou os dados
    p++;
    if (p >= cap) truncated = true;  // parou no teto com a última página ainda CHEIA = há mais dados não lidos
  }
  // GUARD: paginação truncada = número subcontado; vira pendência no painel em vez de passar silencioso
  if (truncated) {
    const msg = `truncado: ${String(q).split('?')[0]} parou em ${nfmt(all.length)} linhas (teto ${nfmt(cap * 1000)}) com dados ainda por ler — SUBCONTADO; subir maxPages ou filtrar a query`;
    SBWARN.push(msg); log('⚠️ TRUNCAMENTO —', msg);
  }
  return all;
}
const nfmt = (n) => n.toLocaleString('pt-BR');

const PIPE33 = [460, 461, 462, 463, 464, 465, 466, 467];
const LOSS_LABELS = {
  lost_weak_pure_brand: 'Marca fraca', lost_cs_low: 'Company Score baixo', enrique_only_no_contact: 'Sem contato encontrado',
  lost_low_volume: 'Volume / mercado baixo', lost_duplicate: 'Duplicidade', garimpo_no_channel: 'Sem canal (e-mail/tel)',
  invalid_produto_principal: 'Produto principal inválido', lost_ps_low: 'Product Score baixo', cs_missing_dimensions: 'Dimensões insuficientes',
  cs_endpoint_failed: 'Company Score: endpoint falhou', garimpo_no_contacts: 'Garimpo: 0 contatos', gd_no_opportunity: 'Golpes: sem oportunidade',
  bbp_neon_query_error: 'BBP: query no Neon falhou', bbp_vc_monitoria_ausente: 'BBP: monitoria (VC) ausente', pescaria_travada: 'Pescaria travada (loop)',
  lost_other: 'Outros (não classificado)', lost_invalid_data: 'Dado inválido', lost_nonbr_junk: 'Lixo / não-brasileiro',
  invalid_domain_domain_empty: 'Domínio vazio', all_campaigns_failed: 'Todas as campanhas falharam', monitoring_state_error: 'Estado de monitoria inconsistente',
};
const INFRA = new Set(['cs_endpoint_failed', 'cs_throw', 'cs_timeout', 'cs_worker_error', 'cs_exception', 'bb4d_failed', 'bb4d_throw', 'bbp_neon_query_error', 'bbp_vc_monitoria_ausente', 'pescaria_travada', 'neon_error', 'monitoring_state_error', 'unknown_decision', 'unknown_classification', 'all_campaigns_failed']);
// Perdas marcadas como recuperáveis pela taxonomia da Lia (monitor-taxonomy.js) = falso negativo re-drivável
const RECOVERABLE = new Set(['lost_weak_pure_brand', 'lost_cs_low', 'lost_ps_low', 'no_coverage', 'garimpo_no_channel', 'garimpo_no_contacts', 'enrique_only_no_contact', 'cs_missing_dimensions', 'no_keywords_after_cs']);
// Tarifa R$/crédito por provider (fonte: enrique/lib/enrichment/cost-brl.ts)
const RATE_PER_CREDIT = { apollo: 0.05, findymail: 0.40, fullenrich: 0.50, debounce: 0.02, cnpja: 0.25, gemini: 0, brasilapi: 0 };
// Lead Generator Supabase (cai no Supabase da Lia se não houver creds próprias — mesma instância possível)
const LG_URL = (process.env.LEADGEN_SUPABASE_URL || process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const LG_KEY = process.env.LEADGEN_SERVICE_ROLE_KEY || process.env.LEADGEN_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || '';
// Normaliza a string livre de reason do Lead Generator em categorias legíveis + selo técnico
function lgReasonCategory(reason) {
  const r = String(reason || '');
  if (/^lost_within_cooldown/.test(r)) return { label: 'Reentrada em cooldown (<60d)', tecnico: false };
  if (/^open_deal_exists/.test(r)) return { label: 'Já existe deal aberto (dedup)', tecnico: false };
  if (/^won_deal_exists/.test(r)) return { label: 'Cliente ativo (deal ganho)', tecnico: false };
  if (/^dedup_search_failed/.test(r)) return { label: 'Falha na busca de duplicidade', tecnico: true };
  if (/^pipeline_error/.test(r)) return { label: 'Erro de pipeline', tecnico: true };
  if (/non_brazilian_brand/.test(r)) return { label: 'Marca não-brasileira', tecnico: false };
  if (/invalid_domain|public_suffix|core_too_short|core_too_generic/.test(r)) return { label: 'Domínio inválido / sem site', tecnico: false };
  if (/name_mentions_client_brand/.test(r)) return { label: 'Nome cita marca de cliente', tecnico: false };
  if (/price_pattern|ad_copy/.test(r)) return { label: 'Nome é anúncio, não a marca', tecnico: false };
  if (/safety_net_existing_org/.test(r)) return { label: 'Org já existe (safety-net)', tecnico: false };
  return { label: r || '(sem motivo)', tecnico: false };
}

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
      for (const [name, id] of [['novo460', 460], ['requa461', 461], ['cs462', 462], ['bb463', 463], ['bbp464', 464], ['golpes465', 465], ['vm466', 466], ['garimpo467', 467], ['prospeccao434', 434]]) out.openByStage[name] = await pdOpenCount(id);
      out.sources.pipedrive = 'ok';
      log('pipedrive ok · criados30d=', created['30']);
    } catch (e) { out.warnings.push('Pipedrive falhou: ' + e.message); log('pipedrive ERRO', e.message); }
  } else out.warnings.push('PIPEDRIVE_API_TOKEN ausente');

  // ===== Supabase Lia =====
  if (SB && KEY) {
    const since = new Date(CUT['30']).toISOString();
    try {
      const cs = await sbPage(SB, KEY, `company_scores?select=deal_id,approved,score_total,decision_reason,calculated_at,score_semrush,score_investment,score_employees,score_instagram,semrush_volume,investment,employees,instagram_followers&calculated_at=gte.${since}&order=calculated_at.desc`);
      const scored = WSet(), approved = WSet(), scDay = {}, apDay = {};
      // Histograma da distribuição do score (último score por deal, 30d) × aprovado/reprovado
      const seen = new Set();
      // Dimensões: por que reprova (média por dimensão aprovado vs reprovado + % sinal cru ausente)
      const dimA = { ss: 0, si: 0, se: 0, sin: 0, n: 0 }, dimR = { ss: 0, si: 0, se: 0, sin: 0, n: 0 }, missR = { vol: 0, inv: 0, emp: 0, ins: 0 };
      const HB = [{ range: '0–1', lo: 0, hi: 1 }, { range: '1–2', lo: 1, hi: 2 }, { range: '2–3', lo: 2, hi: 3 }, { range: '3–4', lo: 3, hi: 4 }, { range: '≥4', lo: 4, hi: 1e9 }].map(b => ({ ...b, total: 0, approved: 0 }));
      let sumA = 0, nA = 0, sumR = 0, nR = 0;
      for (const r of cs) {
        bumpSet(scored, r.calculated_at, r.deal_id); if (r.approved === true) bumpSet(approved, r.calculated_at, r.deal_id);
        const t = ts(r.calculated_at);
        if (inDailyWin(t)) {
          const k = brtDate(t); const set = (scDay[k] ||= new Set());
          if (!set.has(r.deal_id)) {  // 1ª ocorrência no dia = score mais recente do dia (rows vêm desc)
            set.add(r.deal_id); if (r.approved === true) (apDay[k] ||= new Set()).add(r.deal_id);
            if (typeof r.score_total === 'number') {  // buckets diários do histograma (mesma coorte-por-dia do funil)
              const bi = HB.findIndex(x => r.score_total >= x.lo && r.score_total < x.hi); const idx = bi < 0 ? HB.length - 1 : bi;
              const dd = D(k); (dd.csB ||= [0, 0, 0, 0, 0])[idx]++; (dd.csBA ||= [0, 0, 0, 0, 0]);
              if (r.approved === true) { dd.csBA[idx]++; dd.csSA = (dd.csSA || 0) + r.score_total; dd.csNA = (dd.csNA || 0) + 1; }
              else { dd.csSR = (dd.csSR || 0) + r.score_total; dd.csNR = (dd.csNR || 0) + 1; }
            }
          }
        }
        if (!seen.has(r.deal_id) && typeof r.score_total === 'number') {
          seen.add(r.deal_id);
          const b = HB.find(x => r.score_total >= x.lo && r.score_total < x.hi) || HB[HB.length - 1];
          b.total++; if (r.approved === true) { b.approved++; sumA += r.score_total; nA++; } else { sumR += r.score_total; nR++; }
          const g = r.approved === true ? dimA : dimR;
          g.ss += +r.score_semrush || 0; g.si += +r.score_investment || 0; g.se += +r.score_employees || 0; g.sin += +r.score_instagram || 0; g.n++;
          if (r.approved !== true) { if (!(+r.semrush_volume)) missR.vol++; if (!(+r.investment)) missR.inv++; if (!(+r.employees)) missR.emp++; if (!(+r.instagram_followers)) missR.ins++; }
        }
      }
      for (const k in scDay) D(k).csScored = scDay[k].size;
      for (const k in apDay) D(k).csApproved = apDay[k].size;
      const sc = sizes(scored), ap = sizes(approved);
      setW('csScored', sc); setW('csApproved', ap);
      for (const k of ['hoje', '7', '15', '30']) { out.windows[k].csReproved = sc[k] - ap[k]; out.windows[k].csRate = sc[k] ? +(ap[k] / sc[k] * 100).toFixed(1) : 0; }
      out.csHistogram = { threshold: 2.0, buckets: HB.map(b => ({ range: b.range, total: b.total, approved: b.approved, reproved: b.total - b.approved })), avgApproved: nA ? +(sumA / nA).toFixed(2) : 0, avgReproved: nR ? +(sumR / nR).toFixed(2) : 0, distinctDeals: seen.size };
      const dmean = (g, k) => g.n ? +(g[k] / g.n).toFixed(2) : 0;
      out.csDimensions = {
        max: 1, nApproved: dimA.n, nReproved: dimR.n,
        approved: { semrush: dmean(dimA, 'ss'), investment: dmean(dimA, 'si'), employees: dmean(dimA, 'se'), instagram: dmean(dimA, 'sin') },
        reproved: { semrush: dmean(dimR, 'ss'), investment: dmean(dimR, 'si'), employees: dmean(dimR, 'se'), instagram: dmean(dimR, 'sin') },
        missingReproved: dimR.n ? { volume: Math.round(missR.vol / dimR.n * 100), investment: Math.round(missR.inv / dimR.n * 100), employees: Math.round(missR.emp / dimR.n * 100), instagram: Math.round(missR.ins / dimR.n * 100) } : null,
      };
      log('company_scores ok · unicos30d=', sc['30'], '· histograma deals=', seen.size);
    } catch (e) { out.warnings.push('company_scores falhou: ' + e.message); }
    try {
      const ae = await sbPage(SB, KEY, `automation_errors?select=deal_id,org_name,stage,error_type,error_detail,retries,occurred_at,resolved_at&occurred_at=gte.${since}&order=occurred_at.desc`);
      const tot = W(), infra = W(), byType = {};
      const inc = {};  // por error_type: casos afetados (deals), não-resolvidos, retries, orgs, detalhe, stage — pro painel de operação
      for (const r of ae) {
        bump(tot, r.occurred_at); if (INFRA.has(r.error_type)) bump(infra, r.occurred_at); (byType[r.error_type] ||= W()); bump(byType[r.error_type], r.occurred_at);
        const t = ts(r.occurred_at); if (inDailyWin(t)) { const k = brtDate(t); const dd = D(k); dd.autoTotal++; if (INFRA.has(r.error_type)) dd.infra++; (dd.loss ||= {}); dd.loss[r.error_type] = (dd.loss[r.error_type] || 0) + 1; }
        if (t >= CUT['30']) {
          const g = (inc[r.error_type] ||= { type: r.error_type, count: 0, deals: new Set(), unresolved: 0, maxRetries: 0, orgs: {}, detail: '', stage: r.stage || '', count7: 0, resolved: 0, mttrSum: 0, oldest: 0 });
          g.count++; if (r.deal_id != null) g.deals.add(r.deal_id);
          if (r.resolved_at) { g.resolved++; const dh = (ts(r.resolved_at) - t) / 36e5; if (dh >= 0) g.mttrSum += dh; }
          else { g.unresolved++; const ad = (NOW - t) / DAY; if (ad > g.oldest) g.oldest = ad; }
          const rt = +r.retries || 0; if (rt > g.maxRetries) g.maxRetries = rt;
          if (r.org_name) g.orgs[r.org_name] = (g.orgs[r.org_name] || 0) + 1;
          if (!g.detail && r.error_detail) g.detail = String(r.error_detail).slice(0, 160);
          if (t >= CUT['7']) g.count7++;
        }
      }
      setW('autoTotal', tot); setW('infra', infra);
      const total30 = tot['30'] || 1;
      out.incidents = Object.values(inc).map(g => ({
        type: g.type, label: LOSS_LABELS[g.type] || g.type, count: g.count, count7: g.count7, deals: g.deals.size,
        unresolved: g.unresolved, maxRetries: g.maxRetries, stage: g.stage, detail: g.detail,
        mttrHours: g.resolved ? +(g.mttrSum / g.resolved).toFixed(1) : null, oldestUnresolvedDays: Math.round(g.oldest),
        topOrgs: Object.entries(g.orgs).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => ({ n, c })),
        tecnico: INFRA.has(g.type), recoverable: RECOVERABLE.has(g.type),
      })).sort((a, b) => b.count - a.count);
      out.lossReasons = Object.entries(byType).sort((a, b) => b[1]['30'] - a[1]['30']).slice(0, 10)
        .map(([k, w]) => ({ key: k, label: LOSS_LABELS[k] || k, d7: w['7'], d15: w['15'], d30: w['30'], hoje: w.hoje, share: +(w['30'] / total30 * 100).toFixed(1), ratePerDay7: +(w['7'] / 7).toFixed(1), ratePerDay30: +(w['30'] / 30).toFixed(1), recoverable: RECOVERABLE.has(k), tecnico: INFRA.has(k) }));
      // Sumário negócio × técnico × recuperável (30d) — para o selo agregado
      out.lossSummary = { total: total30, tecnico: 0, recuperavel: 0, legitima: 0 };
      for (const [k, w] of Object.entries(byType)) { if (INFRA.has(k)) out.lossSummary.tecnico += w['30']; else if (RECOVERABLE.has(k)) out.lossSummary.recuperavel += w['30']; else out.lossSummary.legitima += w['30']; }
      // meta p/ o front categorizar/rotular os buckets diários por qualquer intervalo
      out.lossMeta = { labels: LOSS_LABELS, recoverable: [...RECOVERABLE], infra: [...INFRA] };
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
      // exclui pipedrive.webhook no servidor (é auditoria, ~85% das linhas e sem custo) + ordena por data + teto alto p/ não truncar (~53k linhas reais/30d)
      const runs = await sbPage(ENQ_URL, ENQ_KEY, `enrichment_runs?select=enrichment_id,status,cost_data_credits,started_at&started_at=gte.${since}&enrichment_id=not.like.pipedrive*&order=started_at.desc`, 'garimpo', 80);
      const prov = {};
      for (const r of runs) {
        const p = String(r.enrichment_id || '?').split('.')[0]; if (p === 'pipedrive') continue;
        const t = ts(r.started_at); const cr = +r.cost_data_credits || 0; const ok = r.status === 'success';
        (prov[p] ||= { calls: 0, success: 0, credits: 0 }); prov[p].calls++; if (ok) prov[p].success++; prov[p].credits += cr;
        if (inDailyWin(t)) { const dd = D(brtDate(t)); const pp = ((dd.prov ||= {})[p] ||= { c: 0, s: 0, cr: 0 }); pp.c++; if (ok) pp.s++; pp.cr += cr; }  // bucket diário p/ o filtro
      }
      out.providers = Object.entries(prov).map(([name, v]) => ({ name, calls: v.calls, successRate: v.calls ? +(v.success / v.calls * 100).toFixed(0) : 0, errorRate: v.calls ? +((1 - v.success / v.calls) * 100).toFixed(0) : 0, credits: Math.round(v.credits), brl: +(v.credits * (RATE_PER_CREDIT[name] || 0)).toFixed(2) })).sort((a, b) => b.credits - a.credits);
      out.providerRates = RATE_PER_CREDIT;
      out.sources.enrique_garimpo = 'ok';
      log('enrique garimpo ok · providers=', out.providers.length);
    } catch (e) { out.warnings.push('Enrique garimpo falhou: ' + e.message); }
  } else out.warnings.push('Enrique service_role ausente — providers/áreas via garimpo.* não populados');

  // ===== Lead Generator: motivos de descarte (qualification_leads_run) =====
  if (LG_URL && LG_KEY) {
    try {
      const since30 = brtDate(NOW - 30 * DAY);
      const rows = await sbPage(LG_URL, LG_KEY, `qualification_leads_run?select=action,reason,run_date&run_date=gte.${since30}`);
      if (rows.length || out.sources.leadgen === undefined) {
        let created = 0, reopened = 0, skipped = 0; const byCat = {};
        for (const r of rows) {
          if (r.action === 'created') created++;
          else if (r.action === 'reopened') reopened++;
          else if (r.action === 'skipped') { skipped++; const c = lgReasonCategory(r.reason); (byCat[c.label] ||= { label: c.label, count: 0, tecnico: c.tecnico }); byCat[c.label].count++; }
        }
        out.leadgen = { created, reopened, skipped, reasons: Object.values(byCat).sort((a, b) => b.count - a.count) };
        out.sources.leadgen = rows.length ? 'ok' : 'vazio';
        log('lead-generator ok · skipped30d=', skipped, '· motivos=', out.leadgen.reasons.length);
      }
    } catch (e) { out.warnings.push('Lead Generator (qualification_leads_run) indisponível: ' + e.message + ' — descartes do LG não populados'); }
  } else out.warnings.push('Lead Generator Supabase ausente — motivos de descarte não populados');

  out.daily = daily;
  for (const m of SBWARN) out.warnings.push(m);  // guard: expõe consultas truncadas como pendência no painel
  out.truncations = SBWARN.slice();
  const dest = path.join(process.cwd(), 'public', 'data.json');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // histórico de incidentes: snapshot diário persistido no data.json (sobrevive entre coletas) → "novo/resolvido desde ontem" de verdade
  let hist = [];
  try { const prev = JSON.parse(fs.readFileSync(dest, 'utf8')); if (Array.isArray(prev.incidentHistory)) hist = prev.incidentHistory; } catch {}
  const snapTypes = {};
  for (const i of out.incidents || []) snapTypes[i.type] = { count: i.count, unresolved: i.unresolved, deals: i.deals };
  hist = hist.filter(h => h.date !== TODAY_BRT);            // re-run no mesmo dia substitui
  hist.push({ date: TODAY_BRT, types: snapTypes });
  out.incidentHistory = hist.slice(-45);                    // mantém ~45 dias
  log('incidentHistory · dias=', out.incidentHistory.length);
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  log('gravado', dest, '· avisos:', out.warnings.length);
}
main().catch((e) => { console.error('[collect] FATAL', e); process.exit(1); });

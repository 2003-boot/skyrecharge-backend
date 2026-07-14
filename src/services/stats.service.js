import db from '../config/database.js';
import redis from '../config/redis.js';

// ─── Config (taux, modifiables sans redéploiement via table config) ───────

const DEFAULTS = {
  app_fee_percent: 10,
  babimo_fee_percent: 5,
  moov_bonus_percent: 4.5,
  moov_bonus_tranche: 10000,
  balance_alert_threshold: 5000,
};

const getConfigNumber = async (key) => {
  const result = await db.query('SELECT value FROM config WHERE key = $1', [key]);
  const raw = result.rows[0]?.value;
  const parsed = raw !== undefined ? parseFloat(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : DEFAULTS[key];
};

// ─── Bornes de période (jour / semaine / mois en cours) ───────────────────
// NB: basé sur l'horloge du serveur. Si le VPS n'est pas en heure d'Abidjan
// (UTC, donc identique en pratique — pas de décalage), rien à faire ; sinon
// il faudra passer par une lib de timezone (date-fns-tz) ici.

export const getPeriodRange = (period) => {
  const now = new Date();
  const end = now;
  let start;

  if (period === 'day') {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (period === 'week') {
    const day = now.getDay(); // 0 = dimanche
    const diffToMonday = (day === 0 ? -6 : 1) - day;
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMonday);
  } else if (period === 'month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
  } else {
    throw new Error(`Période inconnue: ${period}`);
  }

  return { start, end };
};

// ─── Chiffre d'affaires + bénéfice app (SkyRecharge) ───────────────────────
// CA = somme des total_amount (montant payé par le client, frais inclus).
// Bénéfice app = somme des frais app (colonne `fees`, figée au moment de la
// commande) moins les frais Babimo (X% du total_amount, phase de test avec
// agrégateur — à revoir le jour où les API opérateurs remplacent Babimo).
export const getRevenueAndAppMargin = async (start, end) => {
  const babimoFeePercent = await getConfigNumber('babimo_fee_percent');

  const result = await db.query(
    `SELECT
       COALESCE(SUM(total_amount), 0) AS revenue,
       COALESCE(SUM(fees), 0) AS app_fees
     FROM orders
     WHERE status = 'completed'
       AND completed_at >= $1 AND completed_at < $2`,
    [start, end]
  );

  const revenue = Number(result.rows[0].revenue);
  const appFees = Number(result.rows[0].app_fees);
  const babimoFees = Math.round(revenue * (babimoFeePercent / 100));
  const appMargin = appFees - babimoFees;

  return { revenue, appFees, babimoFees, appMargin };
};

// ─── Nombre de transactions par opérateur ──────────────────────────────────
export const getTransactionCountsByOperator = async (start, end) => {
  const result = await db.query(
    `SELECT operator, COUNT(*) AS count
     FROM orders
     WHERE status = 'completed'
       AND completed_at >= $1 AND completed_at < $2
     GROUP BY operator`,
    [start, end]
  );

  const counts = { MTN: 0, Orange: 0, Moov: 0 };
  result.rows.forEach(row => {
    if (row.operator in counts) counts[row.operator] = Number(row.count);
  });
  return counts;
};

// ─── Bénéfice Moov, par tranches de 10 000f cumulés ────────────────────────
// Le bonus Moov (4.5%) est versé par palier — pour une période donnée, on
// calcule combien de paliers ont été franchis entre le cumul d'avant et le
// cumul d'après, pas juste 4.5% des recharges de la période isolément
// (un palier peut être à cheval entre deux jours).
export const getMoovBonus = async (start, end) => {
  const bonusPercent = await getConfigNumber('moov_bonus_percent');
  const tranche = await getConfigNumber('moov_bonus_tranche');
  const bonusPerTranche = Math.round(tranche * (bonusPercent / 100));

  const cumBeforeResult = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM orders
     WHERE status = 'completed' AND operator = 'Moov' AND completed_at < $1`,
    [start]
  );
  const cumAfterResult = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM orders
     WHERE status = 'completed' AND operator = 'Moov' AND completed_at < $1`,
    [end]
  );

  const cumBefore = Number(cumBeforeResult.rows[0].total);
  const cumAfter = Number(cumAfterResult.rows[0].total);

  const bonusBefore = Math.floor(cumBefore / tranche) * bonusPerTranche;
  const bonusAfter = Math.floor(cumAfter / tranche) * bonusPerTranche;

  return {
    bonus: bonusAfter - bonusBefore,
    // Utile pour du debug/vérif manuelle, pas affiché forcément
    cumBefore,
    cumAfter,
  };
};

// ─── Taux de remboursement (indicateur bonus) ──────────────────────────────
export const getRefundRate = async (start, end) => {
  const result = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'refunded') AS refunded,
       COUNT(*) AS total
     FROM orders
     WHERE created_at >= $1 AND created_at < $2
       AND status IN ('completed', 'refunded', 'failed')`,
    [start, end]
  );

  const refunded = Number(result.rows[0].refunded);
  const total = Number(result.rows[0].total);
  return {
    refunded,
    total,
    rate: total > 0 ? Math.round((refunded / total) * 1000) / 10 : 0, // %, 1 décimale
  };
};

// ─── Soldes fournisseurs (lecture Redis, écrits par worker.py) ────────────
// modem_balance:{operator}          → solde EVD (sert aux recharges)
// modem_balance_benefit:orange      → solde bénéfice Orange (#161*2#)
const readBalance = async (key) => {
  try {
    const raw = await redis.get(key);
    if (!raw) return { balance: null, checkedAt: null };
    const parsed = JSON.parse(raw);
    return { balance: parsed.balance ?? null, checkedAt: parsed.checked_at ?? null };
  } catch {
    return { balance: null, checkedAt: null };
  }
};

export const getSupplierBalances = async () => {
  const [evdOrange, evdMoov, benefitOrange] = await Promise.all([
    readBalance('modem_balance:orange'),
    readBalance('modem_balance:moov'),
    readBalance('modem_balance_benefit:orange'),
  ]);

  // Même seuil que balance-monitor.service.js (clé config partagée) —
  // uniquement pertinent pour les soldes EVD (servent aux recharges), pas
  // pour le bénéfice Orange qui n'est jamais dépensé.
  const threshold = await getConfigNumber('balance_alert_threshold');
  const withLowFlag = (reading) => ({
    ...reading,
    isLow: reading.balance !== null && reading.balance < threshold,
  });

  return {
    evdOrange: withLowFlag(evdOrange),
    evdMoov: withLowFlag(evdMoov),
    benefitOrange,
    threshold,
  };
};

// ─── Série temporelle CA/marge (courbe d'évolution) ────────────────────────
// Un point par jour sur les N derniers jours (aujourd'hui inclus).
export const getRevenueTimeseries = async (days = 14) => {
  const result = await db.query(
    `SELECT
       DATE(completed_at) AS date,
       COALESCE(SUM(total_amount), 0) AS revenue,
       COALESCE(SUM(fees), 0) AS app_fees
     FROM orders
     WHERE status = 'completed'
       AND completed_at >= NOW() - ($1 || ' days')::interval
     GROUP BY DATE(completed_at)
     ORDER BY date ASC`,
    [days]
  );

  const babimoFeePercent = await getConfigNumber('babimo_fee_percent');
  const byDate = {};
  result.rows.forEach(row => {
    const revenue = Number(row.revenue);
    const appFees = Number(row.app_fees);
    const babimoFees = Math.round(revenue * (babimoFeePercent / 100));
    byDate[row.date.toISOString().slice(0, 10)] = {
      revenue,
      appMargin: appFees - babimoFees,
    };
  });

  // Compléter les jours sans transaction avec des zéros — un trou dans le
  // graphe serait ambigu (pas de donnée vs vraiment zéro).
  const points = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    points.push({ date: key, ...(byDate[key] || { revenue: 0, appMargin: 0 }) });
  }

  return points;
};

// ─── Données brutes pour l'export CSV (routes/orders.controller.js) ───────
export const getOrdersForExport = async (start, end) => {
  const result = await db.query(
    `SELECT o.id, o.order_type, o.beneficiary_phone, o.operator,
            o.amount, o.fees, o.total_amount, o.status,
            o.created_at, o.completed_at,
            u.first_name AS user_first_name, u.phone AS user_phone
     FROM orders o
     LEFT JOIN users u ON u.id = o.user_id
     WHERE o.created_at >= $1 AND o.created_at < $2
     ORDER BY o.created_at DESC`,
    [start, end]
  );
  return result.rows;
};

// ─── Résumé complet pour une période (endpoint /admin/stats) ──────────────
export const getStatsSummary = async (period) => {
  const { start, end } = getPeriodRange(period);

  const [revenueMargin, txCounts, moovBonus, refundRate] = await Promise.all([
    getRevenueAndAppMargin(start, end),
    getTransactionCountsByOperator(start, end),
    getMoovBonus(start, end),
    getRefundRate(start, end),
  ]);

  return {
    period,
    range: { start, end },
    revenue: revenueMargin.revenue,
    appMargin: revenueMargin.appMargin,
    moovBonus: moovBonus.bonus,
    transactionsByOperator: txCounts,
    refundRate,
  };
};
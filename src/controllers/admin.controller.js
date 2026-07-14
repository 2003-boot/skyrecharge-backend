import db from '../config/database.js';
import { successResponse, errorResponse } from '../utils/response.js';
import { sendSMS } from '../services/sms.js';
import { initiateCashin, PAYMENT_METHODS } from '../services/babimo.service.js';
import {
  getStatsSummary,
  getSupplierBalances,
  getRevenueTimeseries,
  getOrdersForExport,
  getPeriodRange,
} from '../services/stats.service.js';

// ─── GET /api/admin/stats?period=day|week|month ────────────────────────────
export const getStats = async (req, res) => {
  try {
    const period = ['day', 'week', 'month'].includes(req.query.period)
      ? req.query.period
      : 'day';

    const summary = await getStatsSummary(period);
    return successResponse(res, summary, 'Statistiques récupérées');
  } catch (error) {
    console.error('Erreur getStats:', error);
    return errorResponse(res, 'Erreur lors du calcul des statistiques', 500);
  }
};

// ─── GET /api/admin/stats/timeseries?days=14 ───────────────────────────────
export const getTimeseries = async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 14));
    const points = await getRevenueTimeseries(days);
    return successResponse(res, { points }, 'Série temporelle récupérée');
  } catch (error) {
    console.error('Erreur getTimeseries:', error);
    return errorResponse(res, 'Erreur lors du calcul de la série temporelle', 500);
  }
};

// ─── GET /api/admin/export/orders.csv?period=day|week|month ───────────────
const escapeCSV = (value) => {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

export const exportOrdersCSV = async (req, res) => {
  try {
    const period = ['day', 'week', 'month'].includes(req.query.period)
      ? req.query.period
      : 'month';
    const { start, end } = getPeriodRange(period);
    const orders = await getOrdersForExport(start, end);

    const headers = [
      'ID', 'Date création', 'Date complétion', 'Type', 'Opérateur',
      'Client', 'Téléphone client', 'Bénéficiaire',
      'Montant', 'Frais', 'Total', 'Statut',
    ];
    const rows = orders.map(o => [
      o.id, o.created_at, o.completed_at || '', o.order_type, o.operator || '',
      o.user_first_name || '', o.user_phone || '', o.beneficiary_phone,
      o.amount, o.fees, o.total_amount, o.status,
    ]);

    const csv = [headers, ...rows]
      .map(row => row.map(escapeCSV).join(','))
      .join('\n');

    const filename = `skyrecharge-transactions-${period}-${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // BOM UTF-8 — évite les accents cassés à l'ouverture dans Excel
    return res.send('\uFEFF' + csv);
  } catch (error) {
    console.error('Erreur exportOrdersCSV:', error);
    return errorResponse(res, 'Erreur lors de la génération de l\'export', 500);
  }
};

// ─── GET /api/admin/balances ────────────────────────────────────────────────
// Soldes EVD Orange/Moov + bénéfice Orange, lus depuis Redis (écrits par
// worker.py). Bénéfice Moov n'y figure pas : il est calculé, pas observé
// (voir getStats → moovBonus).
export const getBalances = async (req, res) => {
  try {
    const balances = await getSupplierBalances();
    return successResponse(res, balances, 'Soldes récupérés');
  } catch (error) {
    console.error('Erreur getBalances:', error);
    return errorResponse(res, 'Erreur lors de la récupération des soldes', 500);
  }
};

// ─── GET /api/admin/orders/recent ──────────────────────────────────────────
export const getRecentOrders = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT o.id, o.order_type, o.beneficiary_phone, o.operator,
              o.amount, o.fees, o.total_amount, o.status,
              o.created_at, o.completed_at,
              u.first_name AS user_first_name, u.phone AS user_phone
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       ORDER BY o.created_at DESC
       LIMIT 10`
    );
    return successResponse(res, { orders: result.rows }, 'Dernières transactions récupérées');
  } catch (error) {
    console.error('Erreur getRecentOrders:', error);
    return errorResponse(res, 'Erreur lors de la récupération des transactions', 500);
  }
};

// ─── GET /api/admin/users/count ────────────────────────────────────────────
export const getUsersCount = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT COUNT(*) FILTER (WHERE is_active) AS active,
              COUNT(*) AS total
       FROM users`
    );
    return successResponse(res, {
      active: Number(result.rows[0].active),
      total: Number(result.rows[0].total),
    }, 'Nombre d\'utilisateurs récupéré');
  } catch (error) {
    console.error('Erreur getUsersCount:', error);
    return errorResponse(res, 'Erreur lors du comptage des utilisateurs', 500);
  }
};

// ─── POST /api/admin/messages ──────────────────────────────────────────────
// body: { target: 'all' | 'single', phone?, message }
// Répond immédiatement avec l'enregistrement créé (total_sent/total_failed
// à 0), puis envoie les SMS en arrière-plan — un envoi à toute la base
// peut prendre du temps, pas question de faire attendre l'admin sur la
// requête HTTP. Le compteur final est mis à jour une fois l'envoi terminé
// ; l'historique (getMessagesHistory) reflète la progression si on
// rafraîchit.
export const sendMessage = async (req, res) => {
  try {
    const { target, phone, message } = req.body;

    if (!target || !['all', 'single'].includes(target)) {
      return errorResponse(res, 'target doit être "all" ou "single"', 400);
    }
    if (!message || !message.trim()) {
      return errorResponse(res, 'Message requis', 400);
    }
    if (target === 'single' && !phone) {
      return errorResponse(res, 'Numéro requis pour un envoi ciblé', 400);
    }

    const insertResult = await db.query(
      `INSERT INTO admin_messages (admin_id, target_type, target_phone, message)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.admin.id, target, target === 'single' ? phone : null, message.trim()]
    );
    const record = insertResult.rows[0];

    // Réponse immédiate — l'admin n'attend pas la fin de l'envoi.
    successResponse(res, { message: record }, 'Envoi lancé', 202);

    // Envoi en arrière-plan (ne bloque pas la réponse déjà partie).
    dispatchMessage(record, target, phone, message.trim()).catch(err => {
      console.error('Erreur dispatchMessage:', err);
    });
  } catch (error) {
    console.error('Erreur sendMessage:', error);
    return errorResponse(res, 'Erreur lors de l\'envoi du message', 500);
  }
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const dispatchMessage = async (record, target, phone, message) => {
  let sent = 0;
  let failed = 0;

  if (target === 'single') {
    const result = await sendSMS(phone, message);
    if (result.success) sent++; else failed++;
  } else {
    const usersResult = await db.query(
      `SELECT phone FROM users WHERE is_active = TRUE`
    );
    // Envoi séquentiel avec un petit délai entre chaque — évite de
    // bombarder l'API HSMS d'un coup sur une base avec beaucoup
    // d'utilisateurs actifs.
    for (const user of usersResult.rows) {
      const result = await sendSMS(user.phone, message);
      if (result.success) sent++; else failed++;
      await sleep(150);
    }
  }

  await db.query(
    `UPDATE admin_messages SET total_sent = $1, total_failed = $2 WHERE id = $3`,
    [sent, failed, record.id]
  );
  console.log(`📨 Message ${record.id} — envoyé: ${sent}, échoué: ${failed}`);
};

// ─── GET /api/admin/messages/history ───────────────────────────────────────
export const getMessagesHistory = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM admin_messages ORDER BY created_at DESC LIMIT 50`
    );
    return successResponse(res, { messages: result.rows }, 'Historique récupéré');
  } catch (error) {
    console.error('Erreur getMessagesHistory:', error);
    return errorResponse(res, 'Erreur lors de la récupération de l\'historique', 500);
  }
};

// ─── POST /api/admin/transfers ─────────────────────────────────────────────
// body: { phone, amount, payment_method }
// Transfert manuel vers un fournisseur après rechargement de l'EVD, via
// l'API cashin Babimo — même mécanisme que les remboursements clients
// (services/babimo.service.js), juste déclenché manuellement par l'admin
// plutôt qu'automatiquement après une commande.
export const createTransfer = async (req, res) => {
  try {
    const { phone, amount, payment_method } = req.body;

    if (!phone || !amount || !payment_method) {
      return errorResponse(res, 'Numéro, montant et moyen de paiement requis', 400);
    }
    const babimoMethod = PAYMENT_METHODS[payment_method];
    if (!babimoMethod) {
      return errorResponse(res, `Moyen de paiement invalide: ${payment_method}`, 400);
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      return errorResponse(res, 'Montant invalide', 400);
    }

    const insertResult = await db.query(
      `INSERT INTO supplier_transfers (admin_id, supplier_phone, amount, payment_method, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING *`,
      [req.admin.id, phone, amount, payment_method]
    );
    const transfer = insertResult.rows[0];

    const transferId = `SUP-${transfer.id}-${Date.now()}`;
    const telephone = phone.replace('+225', '').replace(/\s/g, '');
    const backendUrl = process.env.BACKEND_URL;

    try {
      const cashinData = await initiateCashin({
        refundId: transferId,
        amount,
        telephone,
        paymentMethod: babimoMethod,
        notifyUrl: `${backendUrl}/api/admin/transfers/webhook`,
      });

      const updateResult = await db.query(
        `UPDATE supplier_transfers
         SET babimo_transaction_id = $1
         WHERE id = $2
         RETURNING *`,
        [cashinData.pay_token, transfer.id]
      );

      return successResponse(res, { transfer: updateResult.rows[0] }, 'Transfert initié', 201);
    } catch (cashinError) {
      console.error(`🚨 Échec transfert fournisseur ${transfer.id}:`, cashinError.message);
      await db.query(
        `UPDATE supplier_transfers SET status = 'failed' WHERE id = $1`,
        [transfer.id]
      );
      return errorResponse(res, 'Échec de l\'appel Babimo — transfert marqué en échec', 502);
    }
  } catch (error) {
    console.error('Erreur createTransfer:', error);
    return errorResponse(res, 'Erreur lors de la création du transfert', 500);
  }
};

// ─── POST /api/admin/transfers/webhook ─────────────────────────────────────
// Public (pas d'auth) — appelé par Babimo, même logique que
// payment.controller.js:cashinWebhook mais sur supplier_transfers plutôt
// que sur orders.
export const transferWebhook = async (req, res) => {
  try {
    const { merchant_transaction_id, status } = req.body;
    if (!merchant_transaction_id) return res.status(200).json({ received: true });

    const result = await db.query(
      'SELECT id FROM supplier_transfers WHERE babimo_transaction_id = $1',
      [merchant_transaction_id]
    );
    const transfer = result.rows[0];
    if (!transfer) {
      console.log(`⚠️ Transfert introuvable pour: ${merchant_transaction_id}`);
      return res.status(200).json({ received: true });
    }

    const newStatus = status === 'SUCCESS' ? 'completed' : 'failed';
    await db.query(
      `UPDATE supplier_transfers SET status = $1 WHERE id = $2`,
      [newStatus, transfer.id]
    );

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('Erreur transferWebhook:', error.message);
    return res.status(200).json({ received: true });
  }
};

// ─── GET /api/admin/transfers/history ──────────────────────────────────────
export const getTransfersHistory = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM supplier_transfers ORDER BY created_at DESC LIMIT 50`
    );
    return successResponse(res, { transfers: result.rows }, 'Historique récupéré');
  } catch (error) {
    console.error('Erreur getTransfersHistory:', error);
    return errorResponse(res, 'Erreur lors de la récupération de l\'historique', 500);
  }
};
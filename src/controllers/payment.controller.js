import {
  initiatePayment,
  checkPaymentStatus,
  initiateCashin,
  PAYMENT_METHODS,
  requiresRedirect,
} from '../services/babimo.service.js';
import db from '../config/database.js';
import { successResponse, errorResponse } from '../utils/response.js';
import { io } from '../server.js';
import { sendUSSD } from '../services/ussd.service.js';
import { sendPushToUser } from '../services/push.service.js';
import { alertInsufficientBalanceNow } from '../services/balance-monitor.service.js';

const MODEM_BY_OPERATOR = {
  'Moov': 'http://192.168.9.1/',
  'Orange': 'http://192.168.8.1/',
};

// Détection opérateur depuis le numéro -- SEULS 01 (Moov), 07 (Orange) et
// 05 (MTN) sont des préfixes valides en Côte d'Ivoire. Ne sert plus que de
// filet de sécurité pour d'anciennes commandes créées avant que
// order.controller.js ne renseigne systématiquement operator à la
// création -- toute nouvelle commande a déjà cette valeur.
const detectOperator = (phone) => {
  const clean = phone.replace('+225', '').replace(/\s/g, '');
  if (clean.startsWith('01')) return 'Moov';
  if (clean.startsWith('07')) return 'Orange';
  if (clean.startsWith('05')) return 'MTN';
  return null;
};

// POST /api/payments/initiate
export const initiateBabimoPayment = async (req, res) => {
  try {
    const { orderId, paymentMethod, paymentPhone } = req.body;

    if (!orderId || !paymentMethod || !paymentPhone) {
      return errorResponse(res, 'Données manquantes', 400);
    }

    const orderResult = await db.query(
      'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
      [orderId, req.user.id]
    );

    const order = orderResult.rows[0];
    if (!order) return errorResponse(res, 'Commande introuvable', 404);
    if (order.status !== 'pending_payment') {
      return errorResponse(res, 'Cette commande ne peut plus être payée', 400);
    }

    const babimoMethod = PAYMENT_METHODS[paymentMethod];
    if (!babimoMethod) {
      return errorResponse(res, 'Moyen de paiement non supporté', 400);
    }

    const backendUrl = process.env.BACKEND_URL;

    // Générer un ID de transaction unique
    const merchantTxId = `PAIE-${orderId}-${Date.now()}`;

    // Initier le paiement via Babimo
    const paymentData = await initiatePayment({
        orderId: merchantTxId,
        amount: order.total_amount,
        telephone: paymentPhone.replace('+225', '').replace(/\s/g, ''),
        paymentMethod: babimoMethod,
        successUrl: `${backendUrl}/api/payments/success`,
        failedUrl: `${backendUrl}/api/payments/failed`,
        notifyUrl: `${backendUrl}/api/payments/webhook`,
    });

    // Mettre à jour la commande
    await db.query(
        `UPDATE orders
        SET status = 'queued',
            wave_transaction_id = $1,
            payment_method = $2,
            payment_phone = $3,
            merchant_transaction_id = $4,
            pay_token = $5,
            updated_at = NOW()
        WHERE id = $6`,
        [paymentData.pay_token, paymentMethod, paymentPhone, merchantTxId, paymentData.pay_token, orderId]
    );

    io.emit('order:queued', { orderId });

    return successResponse(res, {
        payToken: paymentData.pay_token, 
        paymentUrl: paymentData.payment_url || null,
        requiresRedirect: requiresRedirect(babimoMethod),
    }, 'Paiement initié');

  } catch (error) {
    console.error('❌ Erreur initiateBabimoPayment:', error.message);
    return errorResponse(res, 'Erreur lors de l\'initiation du paiement', 500);
  }
};

// Traite un paiement confirmé — appelé par le webhook Babimo OU par le
// polling de statut côté app (processing.tsx). Idempotent : la mise à jour
// SQL est conditionnée sur l'état actuel, donc même si le webhook ET le
// poll détectent le succès en même temps, la recharge n'est déclenchée
// qu'une seule fois.
const handleSuccessfulPayment = async (order) => {
  const result = await db.query(
    `UPDATE orders
     SET status = 'in_progress', updated_at = NOW()
     WHERE id = $1 AND status IN ('queued', 'pending_payment')
     RETURNING *`,
    [order.id]
  );

  if (result.rowCount === 0) {
    // Déjà pris en charge par l'autre chemin → rien à refaire
    return;
  }

  console.log(`✅ Paiement confirmé pour commande ${order.id}`);
  io.emit('order:in_progress', { orderId: order.id });

  processUSSDAfterPayment(order).catch(err => {
    console.error(`❌ Erreur processUSSD: ${err.message}`);
  });
};

// Traite un paiement échoué — même logique d'idempotence que ci-dessus.
const handleFailedPayment = async (order, reason) => {
  const result = await db.query(
    `UPDATE orders
     SET status = 'failed', failure_reason = $1, updated_at = NOW()
     WHERE id = $2 AND status IN ('queued', 'pending_payment')
     RETURNING *`,
    [reason, order.id]
  );

  if (result.rowCount === 0) return;

  console.log(`❌ Paiement échoué pour commande ${order.id}`);
  io.emit('order:failed', { orderId: order.id, reason });
};

// POST /api/payments/webhook
export const babimoWebhook = async (req, res) => {
  try {
    console.log('📥 Webhook Babimo reçu:', req.body);

    const { merchant_transaction_id, status } = req.body;

    if (!merchant_transaction_id) return res.status(200).json({ received: true });

    // Retrouver la commande via merchant_transaction_id
    const orderResult = await db.query(
      'SELECT * FROM orders WHERE merchant_transaction_id = $1',
      [merchant_transaction_id]
    );

    const order = orderResult.rows[0];
    if (!order) {
      console.log(`⚠️ Commande introuvable pour: ${merchant_transaction_id}`);
      return res.status(200).json({ received: true });
    }

    if (status === 'SUCCESS' || status === 'SUCCESSFUL') {
      await handleSuccessfulPayment(order);
    } else if (status === 'FAILED' || status === 'CANCELLED') {
      await handleFailedPayment(order, `Paiement ${status}`);
    }

    return res.status(200).json({ received: true });

  } catch (error) {
    console.error('❌ Erreur webhook:', error.message);
    return res.status(200).json({ received: true });
  }
};

// GET /api/payments/check/:payToken
// Sert de filet de sécurité si le webhook Babimo n'arrive jamais
// (fréquent en dev avec ngrok/localtunnel qui coupent ou changent d'URL).
// L'app poll cette route toutes les 3s depuis processing.tsx ; si Babimo
// confirme le succès ici, on déclenche nous-mêmes la suite (recharge USSD)
// au lieu de se reposer uniquement sur le webhook.
export const checkStatus = async (req, res) => {
  try {
    const { payToken } = req.params;
    const status = await checkPaymentStatus(payToken);

    // Le format exact renvoyé par /check-status n'est pas garanti à 100%,
    // donc on log la réponse brute et on essaie plusieurs chemins possibles.
    console.log('🔍 Réponse check-status Babimo:', JSON.stringify(status));
    const statut =
      status?.data?.status?.statut ||
      status?.data?.statut ||
      status?.status?.statut ||
      status?.statut ||
      status?.status;

    if (statut === 'SUCCESS' || statut === 'SUCCESSFUL') {
      const orderResult = await db.query('SELECT * FROM orders WHERE pay_token = $1', [payToken]);
      const order = orderResult.rows[0];
      if (order) await handleSuccessfulPayment(order);
    } else if (statut === 'FAILED' || statut === 'CANCELLED') {
      const orderResult = await db.query('SELECT * FROM orders WHERE pay_token = $1', [payToken]);
      const order = orderResult.rows[0];
      if (order) await handleFailedPayment(order, `Paiement ${statut}`);
    }

    return successResponse(res, { status });
  } catch (error) {
    console.error('❌ Erreur checkStatus:', error.message);
    return errorResponse(res, 'Erreur lors de la vérification', 500);
  }
};

// Traitement USSD après confirmation du paiement
const processUSSDAfterPayment = async (order) => {
  try {
    const phone = order.beneficiary_phone.replace('+225', '').replace(/\s/g, '');
    const operator = order.operator || detectOperator(order.beneficiary_phone);

    if (!operator) {
      // Ne devrait plus arriver pour une nouvelle commande (operator
      // toujours renseigné dès order.controller.js), mais filet de
      // sécurité pour d'éventuelles anciennes commandes en base sans
      // opérateur ET avec un numéro au préfixe invalide -- mieux vaut
      // rembourser proprement que d'envoyer un USSD au hasard sur le
      // mauvais modem.
      console.error(`❌ Impossible de déterminer l'opérateur pour la commande ${order.id} (numéro: ${order.beneficiary_phone})`);
      await triggerRefund(order, 'Opérateur indéterminable (numéro invalide)', 'other');
      return;
    }

    const modemUrl = MODEM_BY_OPERATOR[operator] || 'http://192.168.9.1/';

    console.log(`🔄 Traitement USSD post-paiement: ${order.id}`);
    console.log(`📱 Opérateur: ${operator} | Modem: ${modemUrl}`);

    let ussdCode;
    let ussdSteps = null;

    if (order.offer_id) {
      const offerResult = await db.query(
        'SELECT ussd_code, ussd_steps FROM operator_offers WHERE id = $1',
        [order.offer_id]
      );
      const offer = offerResult.rows[0];
      if (!offer) throw new Error('Offre introuvable');

      if (offer.ussd_steps) {
        ussdSteps = JSON.parse(JSON.stringify(offer.ussd_steps));
        ussdSteps.initial = ussdSteps.initial.replace('{numero}', phone);
        ussdSteps.steps = ussdSteps.steps.map(step =>
          step === '{numero}' ? phone : step
        );
        ussdCode = ussdSteps.initial;
      } else if (offer.ussd_code) {
        ussdCode = offer.ussd_code.replace('{numero}', phone);
      } else {
        throw new Error('Code USSD introuvable');
      }
    } else {
      if (operator === 'Orange') {
        ussdCode = `#161*${phone}*1#`;
        ussdSteps = {
          initial: `#161*${phone}*1#`,
          steps: [String(order.amount)],
          confirmation: '{secret}',
          secret_code: '2580',
        };
      } else if (operator === 'Moov') {
        ussdCode = `*410*${phone}*${order.amount}*2003#`;
      } else {
        throw new Error(`Opérateur non supporté: ${operator}`);
      }
    }

    const result = await sendUSSD(order.id, ussdCode, ussdSteps, modemUrl, operator);

    if (result.success) {
      await db.query(
        `UPDATE orders
         SET status = 'completed', completed_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [order.id]
      );
      io.emit('order:completed', { orderId: order.id, message: result.content });
      console.log(`✅ Commande ${order.id} complétée!`);
      // Ni push ni entrée dans l'historique in-app pour un succès : le
      // client voit déjà l'écran de succès en direct, et la recharge reste
      // consultable dans "Mes dernières transactions"/l'historique --
      // doublon inutile sur la page Notifications.
      return;
    }

    // Tout échec (quelle que soit la cause) devient "refunded", jamais
    // "failed" — conformément au choix produit : le client ne voit que
    // "réussi" ou "remboursé", jamais un statut d'échec brut.
    const failureType = result.technical_failure === true
      ? 'technical'
      : (result.failure_type || 'other');
    const internalReason = result.error || 'Recharge échouée';

    if (failureType === 'technical') {
      console.error(`⚠️ [PANNE TECHNIQUE] Commande ${order.id} — ${internalReason}`);
    } else {
      console.error(`❌ [ÉCHEC RECHARGE — ${failureType}] Commande ${order.id} — ${internalReason}`);
    }

    await triggerRefund(order, internalReason, failureType);

  } catch (error) {
    console.error(`❌ Erreur processUSSDAfterPayment:`, error.message);
    await triggerRefund(order, error.message, 'technical');
  }
};

// Messages affichés au client selon la cause de l'échec — jamais de
// détail technique interne, mais une explication utile plutôt qu'un
// message générique quand on connaît la vraie cause.
//
// Deux jeux distincts, pour ne JAMAIS affirmer un remboursement qui n'a
// pas réellement eu lieu :
// - REFUND_MESSAGES        : le cashin a réussi, l'argent est reparti.
// - REFUND_MESSAGES_MANUAL : le cashin a échoué ou a été sauté
//   (throttle) — le remboursement est encore à traiter, on ne dit PAS
//   "vous avez été remboursé".
const REFUND_MESSAGES = {
  technical: 'Transaction échouée. Vous avez été remboursé automatiquement.',
  insufficient_balance: 'Solde fournisseur insuffisant. Vous êtes remboursé — réessayez plus tard.',
  network_issue: 'Problème réseau opérateur. Vous êtes remboursé, réessayez dans un instant.',
  other: 'Transaction échouée. Vous avez été remboursé automatiquement.',
};

const REFUND_MESSAGES_MANUAL = {
  technical: 'Transaction échouée. Remboursement en cours de traitement.',
  insufficient_balance: 'Solde fournisseur insuffisant. Remboursement en cours de traitement.',
  network_issue: 'Problème réseau opérateur. Remboursement en cours de traitement.',
  throttled: 'Trop de tentatives récentes. Remboursement en cours de traitement.',
  other: 'Transaction échouée. Remboursement en cours de traitement.',
};

// Anti-spam : chaque remboursement cashin coûte des frais réels (~2%).
// Système basé sur la base de données (pas Redis) — auditable directement
// dans `orders`, sans avoir besoin d'inspecter un compteur Redis à part.
// Deux limites indépendantes sur la MÊME fenêtre (semaine calendaire,
// lundi-dimanche), la première atteinte déclenche le mode manuel :
//   - 3 remboursements automatiques maximum par semaine, tous types
//     d'échec confondus
//   - 10 000f maximum remboursés automatiquement par CLIENT et par SEMAINE
//     (cumulé, pas juste le dernier remboursement) — protège contre un
//     unique remboursement disproportionné autant que contre plusieurs
//     petits qui s'accumulent
const REFUND_WEEKLY_LIMIT = 3;
const REFUND_WEEKLY_AMOUNT_CAP = 10000;

const isRefundThrottled = async (userId, refundAmount) => {
  try {
    const weeklyCountResult = await db.query(
      `SELECT COUNT(*) FROM orders
       WHERE user_id = $1
         AND refund_status IN ('pending', 'completed')
         AND created_at >= date_trunc('week', CURRENT_DATE)`,
      [userId]
    );
    if (parseInt(weeklyCountResult.rows[0].count) >= REFUND_WEEKLY_LIMIT) {
      return true;
    }

    const weeklyAmountResult = await db.query(
      `SELECT COALESCE(SUM(total_amount), 0) AS total FROM orders
       WHERE user_id = $1
         AND refund_status IN ('pending', 'completed')
         AND created_at >= date_trunc('week', CURRENT_DATE)`,
      [userId]
    );
    const alreadyRefundedThisWeek = parseInt(weeklyAmountResult.rows[0].total);
    if (alreadyRefundedThisWeek + refundAmount > REFUND_WEEKLY_AMOUNT_CAP) {
      return true;
    }

    return false;
  } catch (error) {
    // Si la base est indisponible pour cette vérification précise (cas
    // très rare, elle vient déjà d'être interrogée juste avant dans le
    // flux), on ne bloque pas le remboursement — mieux vaut rembourser un
    // peu trop que pas du tout.
    console.error('⚠️ Impossible de vérifier le throttle remboursement:', error.message);
    return false;
  }
};

// Déclenche un remboursement réel via l'API cashin Babimo, et met à jour
// la commande en conséquence. Ne bloque jamais la suite en cas d'échec de
// l'appel cashin lui-même — mais logge très fort, car ce cas précis
// (paiement encaissé, recharge ratée, ET remboursement automatique en
// échec) est le pire scénario business : il nécessite une intervention
// manuelle rapide pour ne pas perdre la confiance du client.
// Notification push commune aux 4 branches de remboursement ci-dessous --
// évite de dupliquer le même appel (et le même risque d'oubli) à chaque
// point de sortie de triggerRefund.
const notifyRefunded = (order, customerMessage) => {
  sendPushToUser(
    order.user_id,
    'Commande remboursée 💸',
    customerMessage,
    { orderId: order.id, type: 'order_refunded' }
  ).catch(err => console.error('⚠️ Push order:refunded non envoyé:', err.message));
};

const triggerRefund = async (order, internalReason, failureType = 'other') => {
  // Alerte fournisseur immédiate — zéro latence contrairement au check
  // périodique (10 min), qui reste un complément préventif mais ne
  // détecte jamais aussi vite qu'un vrai échec en direct.
  if (failureType === 'insufficient_balance' && order.operator) {
    alertInsufficientBalanceNow(order.operator, order.id).catch(err => {
      console.error('⚠️ Alerte solde insuffisant immédiate non envoyée:', err.message);
    });
  }

  // merchant_transaction_id doit être unique à chaque appel cashin —
  // jamais réutiliser celui du paiement d'origine.
  const refundId = `RET-${order.id}-${Date.now()}`;
  const backendUrl = process.env.BACKEND_URL;

  const babimoMethod = PAYMENT_METHODS[order.payment_method];
  const telephone = (order.payment_phone || '').replace('+225', '').replace(/\s/g, '');

  if (!babimoMethod || !telephone) {
    console.error(`🚨 [REMBOURSEMENT IMPOSSIBLE] Commande ${order.id} — payment_method ou payment_phone manquant en base. INTERVENTION MANUELLE REQUISE.`);
    await db.query(
      `UPDATE orders
       SET status = 'refunded', refund_status = 'failed', failure_reason = $1, customer_message = $2, updated_at = NOW()
       WHERE id = $3`,
      [internalReason, REFUND_MESSAGES_MANUAL[failureType] || REFUND_MESSAGES_MANUAL.other, order.id]
    );
    io.emit('order:refunded', { orderId: order.id, refundStatus: 'failed' });
    notifyRefunded(order, REFUND_MESSAGES_MANUAL[failureType] || REFUND_MESSAGES_MANUAL.other);
    return;
  }

  // Anti-spam appliqué à tous les types d'échec (voir isRefundThrottled
  // ci-dessus : 3/semaine ou 10 000f/semaine (cumulé), le premier plafond atteint
  // déclenche la revue manuelle).
  const throttled = await isRefundThrottled(order.user_id, order.total_amount);
  if (throttled) {
    console.warn(`⏸️ [REMBOURSEMENT THROTTLÉ] Commande ${order.id} — trop de remboursements récents pour user ${order.user_id} (type: ${failureType}). Remboursement manuel requis.`);
    await db.query(
      `UPDATE orders
       SET status = 'refunded', refund_status = 'manual_required', failure_reason = $1, customer_message = $2, updated_at = NOW()
       WHERE id = $3`,
      [internalReason, REFUND_MESSAGES_MANUAL.throttled, order.id]
    );
    io.emit('order:refunded', { orderId: order.id, refundStatus: 'manual_required' });
    notifyRefunded(order, REFUND_MESSAGES_MANUAL.throttled);
    return;
  }

  try {
    const cashinData = await initiateCashin({
      refundId,
      amount: order.total_amount,
      telephone,
      paymentMethod: babimoMethod,
      notifyUrl: `${backendUrl}/api/payments/cashin-webhook`,
    });

    console.log(`💸 Remboursement initié pour commande ${order.id} — pay_token: ${cashinData.pay_token}`);

    await db.query(
      `UPDATE orders
       SET status = 'refunded',
           refund_status = 'pending',
           refund_pay_token = $1,
           refund_initiated_at = NOW(),
           failure_reason = $2,
           customer_message = $3,
           updated_at = NOW()
       WHERE id = $4`,
      [cashinData.pay_token, internalReason, REFUND_MESSAGES[failureType] || REFUND_MESSAGES.other, order.id]
    );

    io.emit('order:refunded', { orderId: order.id, refundStatus: 'pending' });
    notifyRefunded(order, REFUND_MESSAGES[failureType] || REFUND_MESSAGES.other);

  } catch (error) {
    // L'appel cashin lui-même a échoué (API Babimo indisponible, solde
    // insuffisant sur le compte marchand, etc.) — le client a payé, la
    // recharge a échoué, ET le remboursement automatique n'est pas parti.
    // Cas le plus critique : à traiter manuellement en priorité.
    console.error(`🚨 [ÉCHEC REMBOURSEMENT CASHIN] Commande ${order.id} — ${error.message}. INTERVENTION MANUELLE REQUISE.`);

    await db.query(
      `UPDATE orders
       SET status = 'refunded', refund_status = 'failed', failure_reason = $1, customer_message = $2, updated_at = NOW()
       WHERE id = $3`,
      [internalReason, REFUND_MESSAGES_MANUAL[failureType] || REFUND_MESSAGES_MANUAL.other, order.id]
    );

    io.emit('order:refunded', { orderId: order.id, refundStatus: 'failed' });
    notifyRefunded(order, REFUND_MESSAGES_MANUAL[failureType] || REFUND_MESSAGES_MANUAL.other);
  }
};

// POST /api/payments/cashin-webhook
// Confirmation asynchrone de Babimo une fois le remboursement traité.
export const cashinWebhook = async (req, res) => {
  try {
    console.log('📥 Webhook Cashin Babimo reçu:', req.body);

    const { merchant_transaction_id, status } = req.body;
    if (!merchant_transaction_id) return res.status(200).json({ received: true });

    const orderResult = await db.query(
      'SELECT id FROM orders WHERE refund_pay_token = $1',
      [merchant_transaction_id]
    );

    const order = orderResult.rows[0];
    if (!order) {
      console.log(`⚠️ Commande introuvable pour remboursement: ${merchant_transaction_id}`);
      return res.status(200).json({ received: true });
    }

    const refundStatus = (status === 'SUCCESS' || status === 'SUCCESSFUL') ? 'completed' : 'failed';

    await db.query(
      `UPDATE orders SET refund_status = $1, updated_at = NOW() WHERE id = $2`,
      [refundStatus, order.id]
    );

    if (refundStatus === 'failed') {
      console.error(`🚨 [REMBOURSEMENT ÉCHOUÉ] Commande ${order.id} — statut Babimo: ${status}. INTERVENTION MANUELLE REQUISE.`);
    } else {
      console.log(`✅ Remboursement confirmé pour commande ${order.id}`);
    }

    return res.status(200).json({ received: true });

  } catch (error) {
    console.error('❌ Erreur cashinWebhook:', error.message);
    return res.status(200).json({ received: true });
  }
};

// GET /api/payments/success
// GET /api/payments/success
export const paymentSuccess = async (req, res) => {
  // Redirige vers l'app (scheme skyrecharge://) — le navigateur intégré
  // ouvert via WebBrowser.openAuthSessionAsync détecte cette redirection
  // et se ferme automatiquement, ramenant l'utilisateur dans l'app.
  return res.redirect('skyrecharge://payment-return?status=success');
};

// GET /api/payments/failed
export const paymentFailed = async (req, res) => {
  return res.redirect('skyrecharge://payment-return?status=failed');
};
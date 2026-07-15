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
import redisClient from '../config/redis.js';
import { sendPushToUser } from '../services/push.service.js';

const MODEM_BY_OPERATOR = {
  'Moov': 'http://192.168.9.1/',
  'Orange': 'http://192.168.8.1/',
};

const detectOperator = (phone) => {
  const clean = phone.replace('+225', '').replace(/\s/g, '');
  if (clean.startsWith('07') || clean.startsWith('08') || clean.startsWith('09')) return 'Orange';
  if (clean.startsWith('01') || clean.startsWith('02') || clean.startsWith('03')) return 'Moov';
  if (clean.startsWith('05') || clean.startsWith('06') || clean.startsWith('04')) return 'MTN';
  return 'Moov';
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
      sendPushToUser(
        order.user_id,
        'Recharge réussie ✅',
        `Votre recharge de ${order.total_amount.toLocaleString('fr-FR')} F a bien été effectuée.`,
        { orderId: order.id, type: 'order_completed' }
      ).catch(err => console.error('⚠️ Push order:completed non envoyé:', err.message));
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
  technical: "Votre transaction n'a pas pu être finalisée. Le remboursement a été initié automatiquement.",
  insufficient_balance: "Le fournisseur ne dispose pas actuellement d'assez de solde pour traiter votre demande. Vous avez été remboursé automatiquement — vous pouvez réessayer avec un montant plus petit, ou plus tard.",
  network_issue: "Un problème de réseau chez votre opérateur a empêché la transaction. Vous avez été remboursé automatiquement — vous pouvez réessayer dans quelques instants.",
  other: "Votre transaction n'a pas pu être finalisée. Le remboursement a été initié automatiquement.",
};

const REFUND_MESSAGES_MANUAL = {
  technical: "Votre transaction n'a pas pu être finalisée. Votre remboursement est en cours de traitement par notre équipe.",
  insufficient_balance: "Le fournisseur ne dispose pas actuellement d'assez de solde pour traiter votre demande. Votre remboursement est en cours de traitement par notre équipe.",
  network_issue: "Un problème de réseau chez votre opérateur a empêché la transaction. Votre remboursement est en cours de traitement par notre équipe.",
  network_issue_throttled: "Plusieurs tentatives ont échoué pour cause de réseau opérateur. Votre remboursement est en cours de traitement par notre équipe.",
  other: "Votre transaction n'a pas pu être finalisée. Votre remboursement est en cours de traitement par notre équipe.",
};

// Anti-spam : chaque remboursement cashin coûte des frais réels (~2%).
// Si un client enchaîne les échecs "réseau opérateur" (souvent en
// retentant la même recharge en boucle), on limite le nombre de
// remboursements automatiques déclenchés sur une fenêtre glissante d'1h,
// pour éviter de payer des frais à répétition sur des tentatives
// probablement redondantes.
const NETWORK_REFUND_LIMIT = 2; // remboursements auto autorisés par heure
const NETWORK_REFUND_WINDOW_SECONDS = 60 * 60;

const isNetworkRefundThrottled = async (userId) => {
  const key = `network_refund_count:${userId}`;
  try {
    const count = await redisClient.incr(key);
    if (count === 1) {
      await redisClient.expire(key, NETWORK_REFUND_WINDOW_SECONDS);
    }
    return count > NETWORK_REFUND_LIMIT;
  } catch (error) {
    // Si Redis est indisponible, on ne bloque pas le remboursement —
    // mieux vaut rembourser un peu trop que pas du tout.
    console.error('⚠️ Impossible de vérifier le throttle remboursement réseau:', error.message);
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

  // Anti-spam sur les échecs réseau opérateur uniquement — les pannes
  // techniques et soldes insuffisants ne sont pas la faute du client donc
  // pas de raison de le limiter là-dessus.
  if (failureType === 'network_issue') {
    const throttled = await isNetworkRefundThrottled(order.user_id);
    if (throttled) {
      console.warn(`⏸️ [REMBOURSEMENT THROTTLÉ] Commande ${order.id} — trop de remboursements réseau récents pour user ${order.user_id}. Remboursement manuel requis.`);
      await db.query(
        `UPDATE orders
         SET status = 'refunded', refund_status = 'manual_required', failure_reason = $1, customer_message = $2, updated_at = NOW()
         WHERE id = $3`,
        [internalReason, REFUND_MESSAGES_MANUAL.network_issue_throttled, order.id]
      );
      io.emit('order:refunded', { orderId: order.id, refundStatus: 'manual_required' });
      notifyRefunded(order, REFUND_MESSAGES_MANUAL.network_issue_throttled);
      return;
    }
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
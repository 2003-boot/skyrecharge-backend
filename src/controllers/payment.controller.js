import {
  initiatePayment,
  checkPaymentStatus,
  PAYMENT_METHODS,
  requiresRedirect,
} from '../services/babimo.service.js';
import db from '../config/database.js';
import { successResponse, errorResponse } from '../utils/response.js';
import { io } from '../server.js';
import { sendUSSD } from '../services/ussd.service.js';

const MODEM_BY_OPERATOR = {
  'Moov': 'http://192.168.9.1/',
  'Orange': 'http://192.168.8.1/',
  'MTN': 'http://192.168.10.1/',
};

const detectOperator = (phone) => {
  const clean = phone.replace('+225', '').replace(/\s/g, '');
  if (clean.startsWith('07') || clean.startsWith('08') || clean.startsWith('09')) return 'Orange';
  if (clean.startsWith('01') || clean.startsWith('02') || clean.startsWith('03')) return 'Moov';
  if (clean.startsWith('05') || clean.startsWith('06')) return 'MTN';
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
      } else if (operator === 'MTN') {
        ussdCode = `*155*${phone}*${order.amount}#`;
      } else {
        ussdCode = `*410*${phone}*${order.amount}*2003#`;
      }
    }

    const result = await sendUSSD(order.id, ussdCode, ussdSteps, modemUrl);

    if (result.success) {
      await db.query(
        `UPDATE orders
         SET status = 'completed', completed_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [order.id]
      );
      io.emit('order:completed', { orderId: order.id, message: result.content });
      console.log(`✅ Commande ${order.id} complétée!`);
    } else {
      throw new Error(result.error || 'Recharge échouée');
    }

  } catch (error) {
    console.error(`❌ Erreur processUSSDAfterPayment:`, error.message);
    await db.query(
      `UPDATE orders
       SET status = 'failed', failure_reason = $1, updated_at = NOW()
       WHERE id = $2`,
      [error.message, order.id]
    );
    io.emit('order:failed', { orderId: order.id, reason: error.message });
  }
};

// GET /api/payments/success
export const paymentSuccess = async (req, res) => {
  return res.send('<html><body><h1>Paiement réussi !</h1><p>Vous pouvez fermer cette page.</p></body></html>');
};

// GET /api/payments/failed
export const paymentFailed = async (req, res) => {
  return res.send('<html><body><h1>Paiement échoué.</h1><p>Vous pouvez fermer cette page.</p></body></html>');
};
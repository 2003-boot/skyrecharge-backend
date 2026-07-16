import db from '../config/database.js';
import { successResponse, errorResponse } from '../utils/response.js';
import { io } from '../server.js';
import { sendUSSD } from '../services/ussd.service.js';

// Mapping opérateur → modem
const MODEM_BY_OPERATOR = {
  'Moov': 'http://192.168.9.1/',
  'Orange': 'http://192.168.8.1/',
  'MTN': 'http://192.168.9.1/',
};

// Détection opérateur depuis le numéro -- SEULS 01 (Moov), 07 (Orange) et
// 05 (MTN) sont des préfixes valides en Côte d'Ivoire. Tout autre préfixe
// n'est pas une variante d'un de ces opérateurs, c'est un numéro invalide.
const detectOperator = (phone) => {
  const clean = phone.replace('+225', '').replace(/\s/g, '');
  if (clean.startsWith('01')) return 'Moov';
  if (clean.startsWith('07')) return 'Orange';
  if (clean.startsWith('05')) return 'MTN';
  return null;
};

// POST /api/orders
export const createOrder = async (req, res) => {
  try {
    const {
      order_type, beneficiary_phone, beneficiary_name,
      is_self, operator, offer_id, amount,
    } = req.body;

    if (!order_type || !beneficiary_phone || !amount) {
      return errorResponse(res, 'Données manquantes', 400);
    }

    // Pour le crédit, l'opérateur est déduit du numéro (pas de sélection
    // explicite) -- un préfixe qui ne correspond à aucun opérateur valide
    // (seuls 01/05/07 le sont) doit être rejeté ici, avant même de
    // regarder la config -- inutile de créer une commande vouée à
    // échouer côté USSD de toute façon.
    let creditOperator = null;
    if (order_type === 'credit') {
      creditOperator = detectOperator(beneficiary_phone);
      if (!creditOperator) {
        return errorResponse(res, 'Numéro invalide — seuls les préfixes 01 (Moov), 05 (MTN) et 07 (Orange) sont acceptés.', 400);
      }
    }

    const configResult = await db.query(
      `SELECT key, value FROM config
       WHERE key IN ('app_fee_percent', 'min_credit_amount', 'max_credit_amount', 'maintenance_mode', 'blocked_operators')`
    );
    const config = {};
    configResult.rows.forEach(row => { config[row.key] = row.value; });

    // Vérification côté serveur — l'app mobile empêche déjà ça côté
    // interface, mais uniquement en cache/au lancement : un utilisateur
    // déjà sur l'app ne verrait rien changer tant qu'il ne relance pas.
    // Ici, c'est le vrai verrou : aucune commande ne peut être créée
    // pendant une maintenance ou vers un opérateur bloqué, peu importe ce
    // que l'app affiche.
    if (config.maintenance_mode === 'true') {
      return errorResponse(res, 'Le service est actuellement en maintenance. Réessayez plus tard.', 503);
    }

    let blockedOperators = [];
    try {
      blockedOperators = config.blocked_operators ? JSON.parse(config.blocked_operators) : [];
    } catch {
      blockedOperators = [];
    }
    if (blockedOperators.length > 0) {
      // Pour le crédit, l'opérateur soumis par le client n'est pas fiable
      // (pas de sélection explicite en amont) -- on le redétecte depuis
      // le numéro bénéficiaire plutôt que de faire confiance à ce qui est
      // envoyé. Pour les pass, l'opérateur vient du choix explicite de
      // l'offre.
      const effectiveOperator = order_type === 'credit'
        ? creditOperator
        : operator;

      if (effectiveOperator && blockedOperators.includes(effectiveOperator)) {
        return errorResponse(res, `Les services ${effectiveOperator} ne sont pas disponibles actuellement.`, 400);
      }
    }

    // Convertit en nombres les clés numériques -- le reste (maintenance_mode,
    // blocked_operators) reste en texte brut, déjà lu ci-dessus.
    const appFeePercent = parseFloat(config.app_fee_percent);
    const minCreditAmount = parseFloat(config.min_credit_amount);
    const maxCreditAmount = parseFloat(config.max_credit_amount);

    // Frais uniforme de 10% (app_fee_percent) sur toute transaction, peu
    // importe sa nature — crédit ou pass.
    if (order_type === 'credit') {
      if (amount < minCreditAmount) {
        return errorResponse(res, `Montant minimum : ${minCreditAmount} FCFA`, 400);
      }
      // Plafond crédit (5000f par défaut) -- pas de raison équivalente
      // côté pass, dont le prix est fixé par l'offre elle-même.
      if (maxCreditAmount && amount > maxCreditAmount) {
        return errorResponse(res, `Montant maximum pour le crédit : ${maxCreditAmount} FCFA`, 400);
      }
    }

    const fees = Math.round(amount * (appFeePercent / 100));
    const totalAmount = amount + fees;

    const result = await db.query(
      `INSERT INTO orders
       (user_id, order_type, beneficiary_phone, beneficiary_name,
        is_self, operator, offer_id, amount, fees, total_amount, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending_payment')
       RETURNING *`,
      [
        req.user.id, order_type, beneficiary_phone,
        beneficiary_name || null, is_self ?? true,
        // Pour le crédit : valeur calculée et déjà validée côté serveur
        // ci-dessus (creditOperator), pas celle envoyée par le client.
        // Pour les pass : celle choisie explicitement par l'utilisateur.
        (order_type === 'credit' ? creditOperator : operator) || null,
        offer_id || null,
        amount, fees, totalAmount,
      ]
    );

    return successResponse(res, { order: result.rows[0] }, 'Commande créée', 201);
  } catch (error) {
    console.error('Erreur createOrder:', error);
    return errorResponse(res, 'Erreur lors de la création de la commande', 500);
  }
};

// POST /api/orders/:id/pay
export const initiatePayment = async (req, res) => {
  try {
    const { id } = req.params;

    const orderResult = await db.query(
      'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    const order = orderResult.rows[0];
    if (!order) return errorResponse(res, 'Commande introuvable', 404);
    if (order.status !== 'pending_payment') {
      return errorResponse(res, 'Cette commande ne peut plus être payée', 400);
    }

    const transactionId = `DEV_${Date.now()}`;

    await db.query(
      `UPDATE orders
       SET status = 'queued', wave_transaction_id = $1, updated_at = NOW()
       WHERE id = $2`,
      [transactionId, id]
    );

    io.emit('order:queued', { orderId: id });
    console.log(`✅ Commande ${id} en file d'attente`);

    processUSSDOrder(order).catch(err => {
      console.error(`❌ Erreur processUSSDOrder: ${err.message}`);
    });

    return successResponse(res, {
      transactionId,
      totalAmount: order.total_amount,
    }, 'Paiement confirmé, recharge en cours');

  } catch (error) {
    console.error('Erreur initiatePayment:', error);
    return errorResponse(res, 'Erreur paiement', 500);
  }
};

const processUSSDOrder = async (order) => {
  try {
    console.log(`🔄 Traitement USSD pour commande ${order.id}`);

    await db.query(
      `UPDATE orders SET status = 'in_progress', updated_at = NOW() WHERE id = $1`,
      [order.id]
    );

    io.emit('order:in_progress', { orderId: order.id });

    const phone = order.beneficiary_phone.replace('+225', '').replace(/\s/g, '');

    // Déterminer l'opérateur — priorité à order.operator, sinon détecter via le numéro
    const operator = order.operator || detectOperator(order.beneficiary_phone);
    const modemUrl = MODEM_BY_OPERATOR[operator] || 'http://192.168.9.1/';

    console.log(`📱 Opérateur: ${operator}`);
    console.log(`📡 Modem sélectionné: ${modemUrl}`);

    let ussdCode;
    let ussdSteps = null;

    if (order.offer_id) {
      // Pass → récupérer depuis la BDD
      const offerResult = await db.query(
        'SELECT ussd_code, ussd_steps FROM operator_offers WHERE id = $1',
        [order.offer_id]
      );
      const offer = offerResult.rows[0];
      if (!offer) throw new Error('Offre introuvable');

      if (offer.ussd_steps) {
        ussdSteps = JSON.parse(JSON.stringify(offer.ussd_steps));
        // Remplacer {numero} dans initial (Orange) et dans les étapes (Moov)
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
      // Crédit → selon l'opérateur détecté
      if (operator === 'Orange') {
        ussdCode = `#161*${phone}*1#`;
        ussdSteps = {
          initial: `#161*${phone}*1#`,
          steps: [String(order.amount)],
          confirmation: '{secret}',
          secret_code: '2580',
        };
      } else if (operator === 'MTN') {
        // À compléter quand la puce MTN sera disponible
        ussdCode = `*155*${phone}*${order.amount}#`;
      } else {
        // Moov par défaut
        ussdCode = `*410*${phone}*${order.amount}*2003#`;
      }
    }

    console.log(`📤 Code USSD: ${ussdCode}`);
    console.log(`📋 Étapes: ${JSON.stringify(ussdSteps)}`);

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
    console.error(`❌ Erreur processUSSDOrder:`, error.message);

    await db.query(
      `UPDATE orders
       SET status = 'failed', failure_reason = $1, updated_at = NOW()
       WHERE id = $2`,
      [error.message, order.id]
    );

    io.emit('order:failed', { orderId: order.id, reason: error.message });
  }
};

// POST /api/orders/:id/cancel-timeout
// Appelée par processing.tsx quand le paiement n'a toujours pas été
// confirmé après 5 min (MAX_PAYMENT_VERIFICATION_SECONDS côté app) --
// jusqu'ici ce cas laissait la commande bloquée au statut "queued"
// indéfiniment. Idempotent comme handleSuccessfulPayment/handleFailedPayment
// dans payment.controller.js : la clause WHERE status IN (...) fait qu'un
// paiement confirmé en retard par le webhook/checkStatus juste après cet
// appel ne trouvera plus la commande dans ('queued', 'pending_payment') et
// ne la fera donc PAS repartir en traitement -- pas besoin de liste noire
// Redis ici, la commande n'a jamais été poussée dans la file USSD à ce
// stade (voir processUSSDAfterPayment, déclenché uniquement après
// confirmation de paiement).
export const cancelUnpaidOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `UPDATE orders
       SET status = 'cancelled', failure_reason = 'Paiement non validé (timeout 5 min)', updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status IN ('queued', 'pending_payment')
       RETURNING *`,
      [id, req.user.id]
    );

    if (result.rowCount === 0) {
      // Déjà passée à un autre statut entre-temps (paiement confirmé pile
      // au même moment, par ex.) -- pas une erreur, on renvoie juste l'état
      // actuel pour que l'app affiche la bonne chose.
      const current = await db.query('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [id, req.user.id]);
      if (!current.rows[0]) return errorResponse(res, 'Commande introuvable', 404);
      return successResponse(res, { order: current.rows[0] });
    }

    console.log(`🚫 Commande ${id} annulée (paiement non validé après 5 min)`);
    io.emit('order:cancelled', { orderId: id });
    return successResponse(res, { order: result.rows[0] });
  } catch (error) {
    console.error('Erreur cancelUnpaidOrder:', error);
    return errorResponse(res, "Erreur lors de l'annulation", 500);
  }
};

// GET /api/orders/:id
export const getOrder = async (req, res) => {
  try {
    const { id } = req.params;
    // Cet endpoint est poll toutes les 3s pendant le traitement d'une
    // commande (écran processing.tsx) — il ne doit JAMAIS renvoyer une
    // réponse mise en cache (304 avec un corps périmé), sous peine de
    // rater un changement de statut réel (ex: passage à "refunded").
    res.set('Cache-Control', 'no-store');
    const result = await db.query(
      `SELECT o.*, op.name as offer_name
       FROM orders o
       LEFT JOIN operator_offers op ON o.offer_id = op.id
       WHERE o.id = $1 AND o.user_id = $2`,
      [id, req.user.id]
    );
    if (!result.rows[0]) return errorResponse(res, 'Commande introuvable', 404);
    return successResponse(res, { order: result.rows[0] });
  } catch (error) {
    console.error('Erreur getOrder:', error);
    return errorResponse(res, 'Erreur lors de la récupération', 500);
  }
};

// GET /api/orders/history
export const getOrderHistory = async (req, res) => {
  try {
    const { page = 1, limit = 20, type, status } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE o.user_id = $1 AND o.status != \'pending_payment\'';
    const params = [req.user.id];
    let paramCount = 2;

    if (type) { whereClause += ` AND o.order_type = $${paramCount++}`; params.push(type); }
    if (status) { whereClause += ` AND o.status = $${paramCount++}`; params.push(status); }

    params.push(limit, offset);

    const result = await db.query(
      `SELECT o.id, o.order_type, o.beneficiary_phone, o.beneficiary_name,
              o.is_self, o.operator, o.amount, o.fees, o.total_amount,
              o.status, o.created_at, o.completed_at, o.updated_at,
              op.name as offer_name
       FROM orders o
       LEFT JOIN operator_offers op ON o.offer_id = op.id
       ${whereClause}
       ORDER BY o.created_at DESC
       LIMIT $${paramCount++} OFFSET $${paramCount}`,
      params
    );

    const countResult = await db.query(
      `SELECT COUNT(*) FROM orders o ${whereClause}`,
      params.slice(0, -2)
    );

    return successResponse(res, {
      orders: result.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (error) {
    console.error('Erreur getOrderHistory:', error);
    return errorResponse(res, 'Erreur lors de la récupération', 500);
  }
};

// GET /api/offers
export const getOffers = async (req, res) => {
  try {
    const { operator, type, category } = req.query;
    let whereClause = 'WHERE is_active = TRUE';
    const params = [];
    let paramCount = 1;

    if (operator) { whereClause += ` AND operator = $${paramCount++}`; params.push(operator); }
    if (type) { whereClause += ` AND offer_type = $${paramCount++}`; params.push(type); }
    if (category) { whereClause += ` AND category = $${paramCount++}`; params.push(category); }

    const result = await db.query(
      `SELECT * FROM operator_offers ${whereClause} ORDER BY price ASC`,
      params
    );
    return successResponse(res, { offers: result.rows });
  } catch (error) {
    console.error('Erreur getOffers:', error);
    return errorResponse(res, 'Erreur lors de la récupération des offres', 500);
  }
};

// POST /api/orders/:id/wave-callback
export const waveCallback = async (req, res) => {
  return res.status(200).json({ received: true });
};
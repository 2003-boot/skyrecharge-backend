import db from '../config/database.js';
import redisClient from '../config/redis.js';
import { sendNotification } from '../config/firebase.js';
import { io } from '../server.js';

const MISSION_ACCEPT_TIMEOUT = 30; // 30 secondes pour accepter
const MAX_RETRY_ATTEMPTS = 3; // Nombre max de tentatives avant remboursement

// ─── ROUND ROBIN ─────────────────────────────────────────────────────────────

// Obtenir l'index courant du round robin
const getRoundRobinIndex = async () => {
  try {
    const val = await redisClient.get('round_robin_index');
    return val ? parseInt(val) : 0;
  } catch {
    return 0;
  }
};

// Incrémenter l'index du round robin
const incrementRoundRobinIndex = async (total) => {
  try {
    const current = await getRoundRobinIndex();
    const next = (current + 1) % Math.max(total, 1);
    await redisClient.set('round_robin_index', String(next));
    return next;
  } catch {
    return 0;
  }
};

// Trouver le prochain agent disponible en round robin
const findNextAgentRoundRobin = async (requiredBalance, excludeAgentIds = []) => {
  // Récupérer tous les agents éligibles
  const result = await db.query(
    `SELECT id, name, fcm_token, balance, score
     FROM agents
     WHERE status = 'active'
       AND is_online = TRUE
       AND balance >= $1
       AND id NOT IN (
         SELECT agent_id FROM agent_missions
         WHERE status IN ('assigned', 'accepted', 'in_progress')
         AND agent_id IS NOT NULL
       )
       ${excludeAgentIds.length > 0
         ? `AND id NOT IN (${excludeAgentIds.map((_, i) => `$${i + 2}`).join(',')})`
         : ''}
     ORDER BY id ASC`,
    excludeAgentIds.length > 0
      ? [requiredBalance, ...excludeAgentIds]
      : [requiredBalance]
  );

  const agents = result.rows;
  if (agents.length === 0) return null;

  // Appliquer le round robin
  const currentIndex = await getRoundRobinIndex();
  const selectedIndex = currentIndex % agents.length;
  const selectedAgent = agents[selectedIndex];

  // Incrémenter pour la prochaine fois
  await incrementRoundRobinIndex(agents.length);

  console.log(`🔄 Round Robin: ${agents.length} agents disponibles, index ${selectedIndex} → ${selectedAgent.name}`);
  return selectedAgent;
};

// ─── ASSIGNATION ─────────────────────────────────────────────────────────────

export const assignOrderToAgent = async (orderId, excludeAgentIds = [], attemptNumber = 1) => {
  try {
    console.log(`🔄 Assignation commande ${orderId} (tentative ${attemptNumber})`);

    // Vérifier que la commande existe et est en attente
    const orderResult = await db.query(
      `SELECT * FROM orders WHERE id = $1 AND status IN ('queued', 'assigned')`,
      [orderId]
    );
    const order = orderResult.rows[0];
    if (!order) {
      console.log(`⚠️ Commande ${orderId} introuvable ou déjà traitée`);
      return null;
    }

    // Vérifier le nombre max de tentatives
    if (attemptNumber > MAX_RETRY_ATTEMPTS) {
      console.log(`❌ Commande ${orderId} — max tentatives atteint, remboursement`);
      await handleOrderRefund(orderId, 'Aucun agent disponible après plusieurs tentatives');
      return null;
    }

    // Trouver le prochain agent via round robin
    const agent = await findNextAgentRoundRobin(order.amount, excludeAgentIds);

    if (!agent) {
      // Pas d'agent disponible — mettre en file d'attente avec retry dans 60 secondes
      console.log(`⏳ Aucun agent disponible pour commande ${orderId}, retry dans 60s...`);

      await db.query(
        `UPDATE orders SET status = 'queued', updated_at = NOW() WHERE id = $1`,
        [orderId]
      );

      // Réessayer dans 60 secondes
      setTimeout(async () => {
        console.log(`🔁 Retry assignation commande ${orderId}`);
        await assignOrderToAgent(orderId, [], attemptNumber + 1);
      }, 60000);

      return null;
    }

    // Calculer la deadline (30 secondes pour accepter)
    const deadlineAt = new Date(Date.now() + MISSION_ACCEPT_TIMEOUT * 1000);

    // Créer la mission
    const missionResult = await db.query(
      `INSERT INTO agent_missions
       (order_id, agent_id, status, deadline_at, attempt_number)
       VALUES ($1, $2, 'assigned', $3, $4)
       RETURNING *`,
      [orderId, agent.id, deadlineAt, attemptNumber]
    );
    const mission = missionResult.rows[0];

    // Mettre à jour la commande
    await db.query(
      `UPDATE orders SET status = 'assigned', updated_at = NOW() WHERE id = $1`,
      [orderId]
    );

    // Verrouiller dans Redis
    await redisClient.setEx(
      `mission_lock:${orderId}`,
      MISSION_ACCEPT_TIMEOUT + 5,
      agent.id
    );

    // Programmer le timeout
    setTimeout(
      () => handleMissionTimeout(mission.id, orderId, excludeAgentIds, attemptNumber),
      MISSION_ACCEPT_TIMEOUT * 1000
    );

    // Notifier l'agent via push
    if (agent.fcm_token) {
      await sendNotification(
        agent.fcm_token,
        '🔔 Nouvelle mission !',
        `Recharge ${order.order_type === 'credit' ? 'Crédit' : 'Pass'} de ${order.amount} FCFA`,
        {
          missionId: mission.id,
          orderId: order.id,
          orderType: order.order_type,
          amount: String(order.amount),
          beneficiaryPhone: order.beneficiary_phone,
          type: 'new_mission',
        }
      );
    }

    // Notifier le dashboard admin
    io.emit('mission:assigned', {
      missionId: mission.id,
      orderId,
      agentId: agent.id,
      agentName: agent.name,
      attemptNumber,
    });

    // Notifier le client — étape 2 en cours
    io.emit('order:agent_assigned', {
      orderId,
      agentName: agent.name,
    });

    console.log(`✅ Mission ${mission.id} assignée à ${agent.name} (tentative ${attemptNumber})`);
    return mission;

  } catch (error) {
    console.error('❌ Erreur assignOrderToAgent:', error.message);
    throw error;
  }
};

// ─── TIMEOUT ─────────────────────────────────────────────────────────────────

export const handleMissionTimeout = async (missionId, orderId, previousExcluded = [], attemptNumber = 1) => {
  try {
    const missionResult = await db.query(
      `SELECT * FROM agent_missions WHERE id = $1`,
      [missionId]
    );
    const mission = missionResult.rows[0];

    // Mission déjà traitée
    if (!mission || ['accepted', 'in_progress', 'completed'].includes(mission.status)) {
      return;
    }

    console.log(`⏱️ Timeout mission ${missionId} (agent: ${mission.agent_id})`);

    // Marquer comme timeout
    await db.query(
      `UPDATE agent_missions SET status = 'timeout', updated_at = NOW() WHERE id = $1`,
      [missionId]
    );

    // Pénaliser l'agent
    if (mission.agent_id) {
      await applyScorePenalty(mission.agent_id, missionId, 'timeout');
    }

    // Libérer le verrou Redis
    await redisClient.del(`mission_lock:${orderId}`);

    // Remettre en file d'attente
    await db.query(
      `UPDATE orders SET status = 'queued', updated_at = NOW() WHERE id = $1`,
      [orderId]
    );

    // Exclure l'agent qui a timeout et réassigner
    const newExcluded = mission.agent_id
      ? [...previousExcluded, mission.agent_id]
      : previousExcluded;

    console.log(`🔁 Réassignation après timeout, agents exclus: ${newExcluded.length}`);

    // Réassigner immédiatement au prochain agent
    await assignOrderToAgent(orderId, newExcluded, attemptNumber + 1);

  } catch (error) {
    console.error('❌ Erreur handleMissionTimeout:', error.message);
  }
};

// ─── REMBOURSEMENT AUTOMATIQUE ────────────────────────────────────────────────

export const handleOrderRefund = async (orderId, reason) => {
  try {
    await db.query(
      `UPDATE orders
       SET status = 'refunded',
           failure_reason = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [reason, orderId]
    );

    // Récupérer le user pour la notification
    const orderResult = await db.query(
      `SELECT o.*, u.fcm_token
       FROM orders o
       JOIN users u ON o.user_id = u.id
       WHERE o.id = $1`,
      [orderId]
    );
    const order = orderResult.rows[0];

    // Notifier le client
    if (order?.fcm_token) {
      await sendNotification(
        order.fcm_token,
        '💰 Remboursement en cours',
        'Aucun agent disponible. Votre paiement Wave sera remboursé sous 24h.',
        { orderId, type: 'refund' }
      );
    }

    // Notifier le dashboard
    io.emit('order:refunded', { orderId, reason });
    io.emit('order:needs_attention', { orderId, reason });

    console.log(`💰 Commande ${orderId} marquée pour remboursement: ${reason}`);
  } catch (error) {
    console.error('❌ Erreur handleOrderRefund:', error.message);
  }
};

// ─── SCORE ───────────────────────────────────────────────────────────────────

export const applyScorePenalty = async (agentId, missionId, reason) => {
  const penalties = { timeout: -5, refused: -5, error: -20 };
  const points = penalties[reason] || -5;

  const agentResult = await db.query(
    'SELECT score FROM agents WHERE id = $1',
    [agentId]
  );
  const currentScore = agentResult.rows[0]?.score || 0;
  const newScore = currentScore + points;

  await db.query(
    `UPDATE agents SET score = $1, updated_at = NOW() WHERE id = $2`,
    [newScore, agentId]
  );

  await db.query(
    `INSERT INTO agent_score_history
     (agent_id, mission_id, action, points, score_before, score_after)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [agentId, missionId, reason, points, currentScore, newScore]
  );

  if (newScore <= 0) {
    await db.query(
      `UPDATE agents SET status = 'suspended', updated_at = NOW() WHERE id = $1`,
      [agentId]
    );
    io.emit('agent:suspended', { agentId, reason: 'Score insuffisant' });
    console.log(`⚠️ Agent ${agentId} suspendu (score: ${newScore})`);
  }

  io.emit('agent:score_updated', { agentId, newScore, points, reason });
};

export const applyScoreBonus = async (agentId, missionId, processingTimeSeconds) => {
  let points = 0;
  if (processingTimeSeconds < 60) points = 10;
  else if (processingTimeSeconds < 120) points = 5;
  else if (processingTimeSeconds < 180) points = 2;
  if (points === 0) return;

  const agentResult = await db.query(
    'SELECT score FROM agents WHERE id = $1',
    [agentId]
  );
  const currentScore = agentResult.rows[0]?.score || 0;
  const newScore = currentScore + points;

  await db.query(
    `UPDATE agents SET score = $1, updated_at = NOW() WHERE id = $2`,
    [newScore, agentId]
  );

  await db.query(
    `INSERT INTO agent_score_history
     (agent_id, mission_id, action, points, score_before, score_after)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [agentId, missionId, 'completed_fast', points, currentScore, newScore]
  );

  io.emit('agent:score_updated', { agentId, newScore, points, reason: 'completed_fast' });
};

// ─── DÉMARRAGE : traiter les commandes en attente au démarrage ────────────────

export const processQueuedOrders = async () => {
  try {
    const result = await db.query(
      `SELECT id FROM orders
       WHERE status = 'queued'
       ORDER BY created_at ASC`
    );

    if (result.rows.length > 0) {
      console.log(`📋 ${result.rows.length} commande(s) en attente au démarrage`);
      for (const order of result.rows) {
        await assignOrderToAgent(order.id);
        // Petit délai entre chaque assignation
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  } catch (error) {
    console.error('❌ Erreur processQueuedOrders:', error.message);
  }
};
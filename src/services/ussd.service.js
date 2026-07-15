import redisClient from '../config/redis.js';

const QUEUE_PREFIX = 'ussd_queue';
const RESULT_PREFIX = 'ussd_result:';
const CANCELLED_PREFIX = 'ussd_cancelled:';
const STARTED_PREFIX = 'ussd_started:';
const POLL_INTERVAL = 1000; // Vérifier toutes les secondes

// Deux plafonds distincts, pas un seul :
//   - QUEUE_TIMEOUT  : temps max qu'une commande peut attendre SON TOUR
//     dans la file avant que le worker ne commence à la traiter. Un trafic
//     dense (plusieurs commandes devant elle sur le même modem) n'est PAS
//     une panne -- large marge (8 min) pour ne jamais rembourser à tort
//     une commande juste derrière d'autres dans la queue.
//   - PROCESSING_TIMEOUT : une fois que le worker a réellement commencé
//     à traiter la commande (code USSD envoyé), le temps normal d'un
//     échange USSD est de quelques secondes à ~1 minute -- 180s reste une
//     marge large pour détecter un vrai blocage EN COURS de transaction.
// Le worker signale explicitement le passage "en traitement" (clé
// ussd_started:{orderId}) dès qu'il sort une commande de la file, ce qui
// permet de savoir lequel des deux chronos appliquer à tout moment.
const QUEUE_TIMEOUT_MS = 8 * 60 * 1000;
const PROCESSING_TIMEOUT_MS = 180 * 1000;

// Durée de vie de l'entrée "annulée" dans Redis — assez longue pour
// couvrir largement le temps que le Pi mette à revenir en ligne après une
// panne, mais pas infinie pour ne pas accumuler des clés indéfiniment.
const CANCELLED_TTL_SECONDS = 24 * 60 * 60;

// Chaque opérateur a sa propre file Redis (ussd_queue:moov, ussd_queue:orange,
// ussd_queue:mtn...) — ça permet au worker Pi de traiter plusieurs modems en
// parallèle au lieu de tout sérialiser dans une seule file commune.
const getQueueName = (operator) => {
  const op = (operator || 'moov').toLowerCase();
  return `${QUEUE_PREFIX}:${op}`;
};

// Envoyer une commande USSD au Pi via Redis
export const sendUSSD = async (orderId, ussdCode, ussdSteps = null, modemUrl = null, operator = null) => {
  try {
    const queueName = getQueueName(operator);

    const command = JSON.stringify({
      order_id: orderId,
      ussd_code: ussdCode,
      ussd_steps: ussdSteps,
      modem_url: modemUrl,
    });

    console.log(`📤 Envoi commande USSD: ${ussdCode} pour commande ${orderId}`);
    console.log(`📡 Modem: ${modemUrl} | File: ${queueName}`);
    await redisClient.lPush(queueName, command);
    console.log(`✅ Commande ajoutée dans Redis (${queueName})`);

    const result = await waitForResult(orderId);
    return result;

  } catch (error) {
    console.error('❌ Erreur sendUSSD:', error.message);
    throw error;
  }
};

// Attendre le résultat du Pi dans Redis. Applique QUEUE_TIMEOUT tant que
// le worker n'a pas encore commencé à traiter la commande, puis bascule
// sur PROCESSING_TIMEOUT (plus court) dès qu'il l'a prise en charge --
// voir le commentaire sur les deux constantes plus haut.
const waitForResult = (orderId) => {
  return new Promise((resolve, reject) => {
    const resultKey = `${RESULT_PREFIX}${orderId}`;
    const startedKey = `${STARTED_PREFIX}${orderId}`;
    const queuedAt = Date.now();
    let processingStartedAt = null;

    console.log(`⏳ Attente résultat Pi pour: ${resultKey} (file: ${QUEUE_TIMEOUT_MS / 1000}s max, traitement: ${PROCESSING_TIMEOUT_MS / 1000}s max)`);

    const giveUp = async (reasonLabel) => {
      console.error(`⏱️ Timeout (${reasonLabel}) pour la commande ${orderId} — panne technique présumée`);

      // Empêche le worker d'exécuter cette commande plus tard s'il
      // revient en ligne après ce timeout (sinon : double perte,
      // remboursement + recharge offerte gratuitement). Le worker
      // revérifie aussi cette liste noire APRÈS son propre traitement,
      // pas seulement avant -- voir worker.py pour le filet de sécurité
      // côté Pi si jamais il a déjà commencé quand ce timeout tombe.
      await redisClient.set(`${CANCELLED_PREFIX}${orderId}`, '1', { EX: CANCELLED_TTL_SECONDS });

      resolve({
        success: false,
        technical_failure: true,
        error: `Timeout (${reasonLabel})`,
      });
    };

    const checkResult = async () => {
      try {
        const result = await redisClient.get(resultKey);

        if (result) {
          const parsed = JSON.parse(result);
          console.log(`📥 Résultat reçu du Pi:`, parsed);
          await redisClient.del(resultKey);
          await redisClient.del(startedKey);
          resolve(parsed);
          return;
        }

        // Le worker a-t-il commencé à traiter cette commande ?
        if (processingStartedAt === null) {
          const started = await redisClient.get(startedKey);
          if (started) {
            processingStartedAt = Date.now();
            console.log(`🚦 [${orderId}] Traitement démarré côté worker — bascule sur le plafond court (${PROCESSING_TIMEOUT_MS / 1000}s)`);
          }
        }

        const now = Date.now();
        if (processingStartedAt !== null) {
          // En cours de traitement actif -> plafond court, un vrai blocage
          // mi-transaction doit être détecté rapidement.
          if (now - processingStartedAt >= PROCESSING_TIMEOUT_MS) {
            await giveUp('traitement actif trop long');
            return;
          }
        } else {
          // Toujours en attente dans la file -> plafond large, un trafic
          // dense n'est pas une panne.
          if (now - queuedAt >= QUEUE_TIMEOUT_MS) {
            await giveUp('attente en file trop longue');
            return;
          }
        }

        setTimeout(checkResult, POLL_INTERVAL);

      } catch (error) {
        reject(error);
      }
    };

    checkResult();
  });
};

// Générer le code USSD selon le type de commande
export const generateUSSDCode = (beneficiaryPhone) => {
  const phone = beneficiaryPhone.replace('+225', '').replace(/\s/g, '');
  return `*410*${phone}*200*2003#`;
};
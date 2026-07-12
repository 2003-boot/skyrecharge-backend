import redisClient from '../config/redis.js';

const QUEUE_PREFIX = 'ussd_queue';
const RESULT_PREFIX = 'ussd_result:';
const CANCELLED_PREFIX = 'ussd_cancelled:';
const POLL_INTERVAL = 1000; // Vérifier toutes les secondes

// Au-delà de ce délai sans réponse du Pi, on considère que c'est une panne
// technique (Pi hors ligne, backend/réseau en carafe...) plutôt que
// d'attendre indéfiniment. 180s = large marge par rapport au temps normal
// d'une transaction USSD (quelques secondes à ~1 minute).
const RESULT_TIMEOUT_MS = 180 * 1000;

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

// Attendre le résultat du Pi dans Redis, avec un plafond de 180s.
// Au-delà, on considère que c'est une panne technique : on blackliste la
// commande (pour que le worker l'ignore s'il revient en ligne plus tard et
// tombe dessus dans la file) et on renvoie un résultat "technical_failure"
// que payment.controller.js saura distinguer d'un échec normal (réseau
// opérateur, solde insuffisant) pour déclencher le bon message et le bon
// type de remboursement.
const waitForResult = (orderId) => {
  return new Promise((resolve, reject) => {
    const resultKey = `${RESULT_PREFIX}${orderId}`;
    const startedAt = Date.now();

    console.log(`⏳ Attente résultat Pi pour: ${resultKey} (timeout ${RESULT_TIMEOUT_MS / 1000}s)`);

    const checkResult = async () => {
      try {
        const result = await redisClient.get(resultKey);

        if (result) {
          const parsed = JSON.parse(result);
          console.log(`📥 Résultat reçu du Pi:`, parsed);
          await redisClient.del(resultKey);
          resolve(parsed);
          return;
        }

        if (Date.now() - startedAt >= RESULT_TIMEOUT_MS) {
          console.error(`⏱️ Timeout: aucun résultat du Pi après ${RESULT_TIMEOUT_MS / 1000}s pour la commande ${orderId} — panne technique présumée`);

          // Empêche le worker d'exécuter cette commande plus tard s'il
          // revient en ligne après ce timeout (sinon : double perte,
          // remboursement + recharge offerte gratuitement).
          await redisClient.set(`${CANCELLED_PREFIX}${orderId}`, '1', { EX: CANCELLED_TTL_SECONDS });

          resolve({
            success: false,
            technical_failure: true,
            error: `Timeout: aucune réponse du worker après ${RESULT_TIMEOUT_MS / 1000}s`,
          });
          return;
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
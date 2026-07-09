// Firebase temporairement désactivé
// À activer quand les credentials Firebase seront configurés

export const sendNotification = async (fcmToken, title, body, data = {}) => {
  try {
    // En dev : juste logger la notification
    console.log('📱 Notification (simulée):', { fcmToken, title, body, data });
    return { success: true, simulated: true };
  } catch (error) {
    console.error('❌ Erreur notification:', error);
    throw error;
  }
};

export default {};
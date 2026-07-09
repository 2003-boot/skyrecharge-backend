import { createClient } from 'redis';

const client = createClient({
  socket: {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
  },
  password: process.env.REDIS_PASSWORD || undefined,
});

client.on('connect', () => {
  console.log('✅ Connecté à Redis');
});

client.on('error', (err) => {
  console.error('❌ Erreur Redis:', err);
});

await client.connect();

export default client;
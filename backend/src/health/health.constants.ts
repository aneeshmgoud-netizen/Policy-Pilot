// Injection token for the dedicated IORedis client used by the readiness
// probe. Kept separate from BullMQ's connection so a health check never
// competes with queue traffic on the same blocking connection.
export const REDIS_HEALTH_CLIENT = 'REDIS_HEALTH_CLIENT';

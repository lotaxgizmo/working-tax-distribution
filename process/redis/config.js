import { createClient } from 'redis';
import dotenv from 'dotenv';

dotenv.config();

// Redis configuration
const REDIS_CONFIG = {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    retryStrategy: (times) => {
        // Retry connection with exponential backoff
        return Math.min(times * 50, 2000);
    }
};

// Create Redis client
const redisClient = createClient(REDIS_CONFIG);

// Error handling
redisClient.on('error', (err) => console.error('Redis Client Error:', err));

// Connect handling
redisClient.on('connect', () => console.log('Redis Client Connected'));

// Export configured client
export default redisClient;

// Helper functions for collector operations
export const CollectorKeys = {
    jobQueue: (collectorId) => `collector:${collectorId}:jobs`,
    status: (collectorId) => `collector:${collectorId}:status`,
    requests: (collectorId) => `collector:${collectorId}:requests`,
    transaction: (wallet) => `tx:${wallet}:last_processed`
};

// Initialize collector status
export async function initializeCollector(collectorId) {
    const status = {
        active: 'true',
        processed: '0',
        failed: '0',
        lastActive: Date.now().toString()
    };
    
    // Store each field individually
    for (const [key, value] of Object.entries(status)) {
        await redisClient.hSet(CollectorKeys.status(collectorId), key, value);
    }
}

// Update collector status
export async function updateCollectorStatus(collectorId, updates) {
    // Ensure all values are strings
    const stringUpdates = Object.fromEntries(
        Object.entries(updates).map(([key, value]) => [key, String(value)])
    );
    
    for (const [key, value] of Object.entries(stringUpdates)) {
        await redisClient.hSet(CollectorKeys.status(collectorId), key, value);
    }
}

// Add jobs to collector queue
export async function addJobsToCollector(collectorId, wallets) {
    const queueKey = CollectorKeys.jobQueue(collectorId);
    // Ensure all wallet addresses are strings
    const walletsArray = wallets.map(String);
    await redisClient.lPush(queueKey, walletsArray);
}

// Get next job from collector queue
export async function getNextJob(collectorId) {
    const queueKey = CollectorKeys.jobQueue(collectorId);
    return await redisClient.rPop(queueKey);
}

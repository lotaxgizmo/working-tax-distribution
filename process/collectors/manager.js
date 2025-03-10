import { PublicKey } from "@solana/web3.js";
import redisClient, { CollectorKeys, initializeCollector, updateCollectorStatus } from '../redis/config.js';

export class CollectorManager {
    constructor(numberOfCollectors = 4) {
        this.numberOfCollectors = numberOfCollectors;
    }

    async initialize() {
        // Initialize Redis connection if not connected
        if (!redisClient.isOpen) {
            await redisClient.connect();
        }

        // Initialize all collectors
        for (let i = 1; i <= this.numberOfCollectors; i++) {
            await initializeCollector(i);
        }
    }

    // Distribute accounts among collectors
    async distributeAccounts(accounts) {
        const batchSize = Math.ceil(accounts.length / this.numberOfCollectors);
        
        for (let i = 0; i < this.numberOfCollectors; i++) {
            const collectorId = i + 1;
            const start = i * batchSize;
            const end = Math.min(start + batchSize, accounts.length);
            const collectorAccounts = accounts.slice(start, end);
            
            // Store accounts in Redis queue for this collector
            if (collectorAccounts.length > 0) {
                const accountAddresses = collectorAccounts.map(acc => acc.toString());
                await redisClient.lPush(CollectorKeys.jobQueue(collectorId), accountAddresses);
                
                // Update collector status
                await updateCollectorStatus(collectorId, {
                    pendingJobs: collectorAccounts.length.toString(),
                    lastUpdated: Date.now().toString()
                });
            }
        }
    }

    // Get next batch of accounts for a collector
    async getNextBatch(collectorId, batchSize = 20) {
        const queueKey = CollectorKeys.jobQueue(collectorId);
        const accounts = [];
        
        for (let i = 0; i < batchSize; i++) {
            const account = await redisClient.rPop(queueKey);
            if (!account) break;
            accounts.push(new PublicKey(account));
        }
        
        return accounts;
    }

    // Update collector progress
    async updateProgress(collectorId, processed, failed) {
        const status = await redisClient.hGetAll(CollectorKeys.status(collectorId));
        
        await updateCollectorStatus(collectorId, {
            processed: (parseInt(status.processed || '0') + processed).toString(),
            failed: (parseInt(status.failed || '0') + failed).toString(),
            lastActive: Date.now().toString()
        });
    }

    // Get status of all collectors
    async getAllCollectorStatus() {
        const status = {};
        for (let i = 1; i <= this.numberOfCollectors; i++) {
            status[`collector${i}`] = await redisClient.hGetAll(CollectorKeys.status(i));
        }
        return status;
    }

    // Check if all collectors are done
    async isProcessingComplete() {
        for (let i = 1; i <= this.numberOfCollectors; i++) {
            const queueLength = await redisClient.lLen(CollectorKeys.jobQueue(i));
            if (queueLength > 0) return false;
        }
        return true;
    }
}
